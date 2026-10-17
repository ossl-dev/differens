//! Lazy correlation over bounded, optionally disk-backed candidate storage.
use crate::{
    ActionId, CorrelateOptions, CrossFileMatch, compatible_file_similarity, named_node, similarity,
    tokens,
};
use differens_core::{NodeRef, NodeSpec, TreeBuilder, trees_equal};

/// An ordered on-disk or in-memory index of candidates.
#[derive(Clone, Copy, Debug)]
pub enum CandidateGroup {
    Deletions(u64),
    Insertions(u64),
    ExactInsertions(u64),
}

/// The small metadata record needed before fetching a candidate tree.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CandidateMeta {
    pub id: ActionId,
    pub file: String,
    pub kind: String,
    pub label: Option<String>,
    pub structure_hash: u64,
    pub exact_key: u64,
    pub deleted: bool,
}
/// Candidate IDs in deterministic ingestion order.
pub type CandidateIndices<'a, E> = Box<dyn Iterator<Item = Result<usize, E>> + 'a>;
/// Distinct deletion hashes in first-seen order.
pub type StructureGroups<'a, E> = Box<dyn Iterator<Item = Result<u64, E>> + 'a>;

/// Correlation storage. Implementations can keep payloads, indexes and claim bits on disk.
/// Every iterator is streamed; none requires materializing a whole bucket.
pub trait CandidateStore {
    type Error;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// # Errors
    /// Returns storage errors without treating unreadable records as absent candidates.
    fn metadata(&self, index: usize) -> Result<CandidateMeta, Self::Error>;
    /// # Errors
    /// Returns malformed snapshot and storage errors.
    fn load(&self, index: usize) -> Result<NodeRef, Self::Error>;
    /// # Errors
    /// Returns index I/O errors.
    fn groups(&self) -> Result<StructureGroups<'_, Self::Error>, Self::Error>;
    /// # Errors
    /// Returns index I/O errors. Missing groups yield an empty iterator.
    fn candidates(
        &self,
        group: CandidateGroup,
    ) -> Result<CandidateIndices<'_, Self::Error>, Self::Error>;
    /// # Errors
    /// Returns claim-record I/O errors.
    fn is_claimed(&self, index: usize) -> Result<bool, Self::Error>;
    /// # Errors
    /// Returns claim-record I/O errors.
    fn claim(&self, index: usize) -> Result<(), Self::Error>;
}

fn exact<S: CandidateStore>(
    store: &S,
    old: &CandidateMeta,
    old_node: &NodeRef,
) -> Result<Option<(usize, f64, bool)>, S::Error> {
    for index in store.candidates(CandidateGroup::ExactInsertions(old.exact_key))? {
        let index = index?;
        if store.is_claimed(index)? {
            continue;
        }
        let new = store.metadata(index)?;
        if old.file == new.file || old.kind != new.kind {
            continue;
        }
        let new_node = store.load(index)?;
        if trees_equal(old_node, &new_node)
            || (old.kind == "file"
                && old_node.value.is_some()
                && old_node.value == new_node.value
                && old_node.scalar_type == new_node.scalar_type)
        {
            return Ok(Some((index, 1.0, false)));
        }
    }
    Ok(None)
}
fn similar<S: CandidateStore>(
    store: &S,
    old: &CandidateMeta,
    old_node: &NodeRef,
    threshold: f64,
) -> Result<Option<(usize, f64, bool)>, S::Error> {
    if old.kind == "file" && old_node.scalar_type.as_deref() == Some("bytes") {
        return Ok(None);
    }
    let mut count = 0usize;
    for index in store.candidates(CandidateGroup::Insertions(old.structure_hash))? {
        index?;
        count += 1;
        if count > 64 {
            break;
        }
    }
    let mut candidates = Vec::with_capacity(count.min(64));
    for index in store.candidates(CandidateGroup::Insertions(old.structure_hash))? {
        let index = index?;
        if count > 64 && store.metadata(index)?.label != old.label {
            continue;
        }
        if candidates.len() == 64 {
            return Ok(None);
        }
        candidates.push(index);
    }
    let old_tokens = tokens(old_node);
    let mut best = None;
    let mut best_score = 0.0;
    for index in candidates {
        if store.is_claimed(index)? {
            continue;
        }
        let new = store.metadata(index)?;
        if old.file == new.file || (old.kind != "file" && old.label != new.label) {
            continue;
        }
        let new_node = store.load(index)?;
        if old.kind == "file" && !compatible_file_similarity(old_node, &new_node) {
            continue;
        }
        let similarity_score = similarity(&old_tokens, &tokens(&new_node));
        if similarity_score > best_score {
            best_score = similarity_score;
            best = Some(index);
        }
    }
    Ok(best
        .filter(|_| best_score >= threshold)
        .map(|index| (index, best_score, true)))
}

/// Correlate lazily without retaining every candidate's AST or token set in RAM.
/// Results contain detached, shallow display nodes. Exact comparisons still load
/// and verify original candidate contents; failures abort rather than hide moves.
///
/// # Errors
/// Propagates every store read/write/validation error.
pub fn correlate_store<S: CandidateStore>(
    store: &S,
    options: CorrelateOptions,
) -> Result<Vec<CrossFileMatch>, S::Error> {
    if !options.is_valid() {
        return Ok(Vec::new());
    }
    let mut moves = Vec::new();
    for hash in store.groups()? {
        let hash = hash?;
        match store.candidates(CandidateGroup::Insertions(hash))?.next() {
            None => continue,
            Some(value) => {
                value?;
            }
        }
        for index in store.candidates(CandidateGroup::Deletions(hash))? {
            let index = index?;
            let old = store.metadata(index)?;
            let old_node = store.load(index)?;
            let matched = match exact(store, &old, &old_node)? {
                Some(matched) => Some(matched),
                None => similar(store, &old, &old_node, options.rename_similarity_threshold)?,
            };
            if let Some((new_index, score, modified)) = matched {
                let new = store.metadata(new_index)?;
                let node = display_node(&named_node(&store.load(new_index)?));
                store.claim(new_index)?;
                moves.push(CrossFileMatch {
                    node,
                    from_file: old.file,
                    to_file: new.file,
                    modified,
                    similarity: score,
                    deletion: old.id,
                    insertion: new.id,
                });
            }
        }
    }
    Ok(moves)
}

fn display_node(node: &NodeRef) -> NodeRef {
    // Move reports expose identity and location, never retained source contents.
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new(&node.kind);
    spec.label.clone_from(&node.label);
    spec.byte_range = node.byte_range;
    spec.line = node.line;
    let id = builder.push(spec).expect("one valid display node");
    NodeRef::new(builder.finish(id).expect("one complete display node"), id)
}
