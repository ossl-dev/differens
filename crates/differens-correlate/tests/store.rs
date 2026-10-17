use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
};

use differens_core::{EditAction, NodeRef, NodeSpec, TreeBuilder, hash_text};
use differens_correlate::{
    ActionId, CandidateGroup, CandidateIndices, CandidateMeta, CandidateStore, CorrelateOptions,
    FileChanges, StructureGroups, correlate, correlate_store,
};

struct MemoryStore {
    nodes: Vec<NodeRef>,
    metadata: Vec<CandidateMeta>,
    claimed: RefCell<Vec<bool>>,
    reads: Cell<usize>,
    metadata_reads: Cell<usize>,
}

impl MemoryStore {
    fn new(files: &[FileChanges]) -> Self {
        let mut nodes = Vec::new();
        let mut metadata = Vec::new();
        for (file, changes) in files.iter().enumerate() {
            for (action, change) in changes.actions.iter().enumerate() {
                let node = change.node();
                metadata.push(CandidateMeta {
                    id: ActionId { file, action },
                    file: changes.file_path.clone(),
                    kind: node.kind.clone(),
                    label: node.label.clone(),
                    structure_hash: node.structure_hash,
                    exact_key: if node.kind == "file" {
                        node.value.as_deref().map_or(node.content_hash, hash_text)
                    } else {
                        node.content_hash
                    },
                    deleted: matches!(change, EditAction::Delete { .. }),
                });
                nodes.push(node.clone());
            }
        }
        let claimed = RefCell::new(vec![false; nodes.len()]);
        Self {
            nodes,
            metadata,
            claimed,
            reads: Cell::new(0),
            metadata_reads: Cell::new(0),
        }
    }
}

impl CandidateStore for MemoryStore {
    type Error = Infallible;
    fn len(&self) -> usize {
        self.nodes.len()
    }
    fn metadata(&self, index: usize) -> Result<CandidateMeta, Self::Error> {
        self.metadata_reads.set(self.metadata_reads.get() + 1);
        Ok(self.metadata[index].clone())
    }
    fn load(&self, index: usize) -> Result<NodeRef, Self::Error> {
        self.reads.set(self.reads.get() + 1);
        Ok(self.nodes[index].clone())
    }
    fn groups(&self) -> Result<StructureGroups<'_, Self::Error>, Self::Error> {
        let mut groups = Vec::new();
        for meta in &self.metadata {
            if meta.deleted && !groups.contains(&meta.structure_hash) {
                groups.push(meta.structure_hash);
            }
        }
        Ok(Box::new(groups.into_iter().map(Ok)))
    }
    fn candidates(
        &self,
        group: CandidateGroup,
    ) -> Result<CandidateIndices<'_, Self::Error>, Self::Error> {
        Ok(Box::new(
            self.metadata
                .iter()
                .enumerate()
                .filter(move |(_, meta)| match group {
                    CandidateGroup::Deletions(hash) => meta.deleted && meta.structure_hash == hash,
                    CandidateGroup::Insertions(hash) => {
                        !meta.deleted && meta.structure_hash == hash
                    }
                    CandidateGroup::ExactInsertions(hash) => {
                        !meta.deleted && meta.exact_key == hash
                    }
                })
                .map(|(index, _)| Ok(index)),
        ))
    }
    fn is_claimed(&self, index: usize) -> Result<bool, Self::Error> {
        Ok(self.claimed.borrow()[index])
    }
    fn claim(&self, index: usize) -> Result<(), Self::Error> {
        self.claimed.borrow_mut()[index] = true;
        Ok(())
    }
}

struct IndexedStore {
    base: MemoryStore,
    groups: std::collections::HashMap<(u8, u64), Vec<usize>>,
    names: std::collections::HashMap<(u64, Option<String>), Vec<usize>>,
    use_names: bool,
    collide_names: bool,
}

impl IndexedStore {
    fn new(files: &[FileChanges], use_names: bool) -> Self {
        let base = MemoryStore::new(files);
        let mut groups: std::collections::HashMap<_, Vec<_>> = std::collections::HashMap::new();
        let mut names: std::collections::HashMap<_, Vec<_>> = std::collections::HashMap::new();
        for (index, meta) in base.metadata.iter().enumerate() {
            if meta.deleted {
                groups
                    .entry((0, meta.structure_hash))
                    .or_default()
                    .push(index);
            } else {
                groups
                    .entry((1, meta.structure_hash))
                    .or_default()
                    .push(index);
                groups.entry((2, meta.exact_key)).or_default().push(index);
                names
                    .entry((meta.structure_hash, meta.label.clone()))
                    .or_default()
                    .push(index);
            }
        }
        Self {
            base,
            groups,
            names,
            use_names,
            collide_names: false,
        }
    }
}

impl CandidateStore for IndexedStore {
    type Error = Infallible;
    fn len(&self) -> usize {
        self.base.len()
    }
    fn metadata(&self, index: usize) -> Result<CandidateMeta, Self::Error> {
        self.base.metadata(index)
    }
    fn load(&self, index: usize) -> Result<NodeRef, Self::Error> {
        self.base.load(index)
    }
    fn groups(&self) -> Result<StructureGroups<'_, Self::Error>, Self::Error> {
        self.base.groups()
    }
    fn candidates(
        &self,
        group: CandidateGroup,
    ) -> Result<CandidateIndices<'_, Self::Error>, Self::Error> {
        let key = match group {
            CandidateGroup::Deletions(hash) => (0, hash),
            CandidateGroup::Insertions(hash) => (1, hash),
            CandidateGroup::ExactInsertions(hash) => (2, hash),
        };
        Ok(Box::new(
            self.groups
                .get(&key)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .copied()
                .map(Ok),
        ))
    }
    fn named_candidates<'a>(
        &'a self,
        structure_hash: u64,
        label: Option<&'a str>,
    ) -> Result<CandidateIndices<'a, Self::Error>, Self::Error> {
        if !self.use_names {
            return self.base.named_candidates(structure_hash, label);
        }
        if self.collide_names {
            return self.candidates(CandidateGroup::Insertions(structure_hash));
        }
        Ok(Box::new(
            self.names
                .get(&(structure_hash, label.map(str::to_owned)))
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .copied()
                .map(Ok),
        ))
    }
    fn is_claimed(&self, index: usize) -> Result<bool, Self::Error> {
        self.base.is_claimed(index)
    }
    fn claim(&self, index: usize) -> Result<(), Self::Error> {
        self.base.claim(index)
    }
}

fn modified_declarations(count: usize) -> Vec<FileChanges> {
    let mut old = Vec::new();
    let mut new = Vec::new();
    for index in 0..count {
        for (destination, value) in [
            (&mut old, "return input alpha beta gamma"),
            (&mut new, "return input alpha beta delta"),
        ] {
            let mut builder = TreeBuilder::new();
            let mut spec = NodeSpec::new("Function");
            spec.label = Some(format!("function{index}"));
            spec.value = Some(value.to_owned());
            let root = builder.push(spec).unwrap();
            destination.push(builder.finish(root).unwrap().root_ref());
        }
    }
    vec![
        FileChanges {
            file_path: "old.rs".to_owned(),
            actions: old
                .into_iter()
                .map(|node| EditAction::Delete {
                    node,
                    context: vec![],
                })
                .collect(),
        },
        FileChanges {
            file_path: "new.rs".to_owned(),
            actions: new
                .into_iter()
                .map(|node| EditAction::Insert {
                    parent: node.clone(),
                    node,
                    position: 0,
                    context: vec![],
                })
                .collect(),
        },
    ]
}

#[test]
fn name_indexes_preserve_moves_with_linear_metadata_reads() {
    let files = modified_declarations(256);
    let expected = correlate(&files, CorrelateOptions::default());
    let store = IndexedStore::new(&files, true);
    let actual = correlate_store(&store, CorrelateOptions::default()).unwrap();
    assert_eq!(actual.len(), 256);
    assert!(store.base.metadata_reads.get() < 8 * 256);
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual.deletion, expected.deletion);
        assert_eq!(actual.insertion, expected.insertion);
        assert_eq!(actual.node.label, expected.node.label);
        assert_eq!(actual.similarity, expected.similarity);
        assert!(actual.modified);
    }
}

#[test]
fn name_hash_collisions_do_not_consume_the_candidate_cap() {
    let files = modified_declarations(70);
    let mut store = IndexedStore::new(&files, true);
    store.collide_names = true;
    let result = correlate_store(&store, CorrelateOptions::default()).unwrap();
    assert_eq!(result.len(), 70);
    assert!(
        result
            .iter()
            .all(|movement| movement.deletion.action == movement.insertion.action)
    );
}

#[test]
#[ignore = "manual release benchmark; compares indexed versus streaming name lookup"]
fn modified_declaration_correlation() {
    for count in [100, 500, 1_000] {
        let files = modified_declarations(count);
        for use_names in [false, true] {
            let mut durations = Vec::new();
            let mut metadata_reads = 0;
            for _ in 0..5 {
                let store = IndexedStore::new(&files, use_names);
                let start = std::time::Instant::now();
                let result = correlate_store(&store, CorrelateOptions::default()).unwrap();
                durations.push(start.elapsed().as_secs_f64() * 1_000.0);
                assert_eq!(result.len(), count);
                metadata_reads = store.base.metadata_reads.get();
            }
            durations.sort_by(f64::total_cmp);
            println!(
                "modified_moves count={count} indexed={use_names} median_ms={:.3} metadata_reads={metadata_reads}",
                durations[2]
            );
        }
    }
}

fn file(name: &str, value: &str, scalar_type: Option<&str>) -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new("file");
    spec.label = Some(name.to_owned());
    spec.value = Some(value.to_owned());
    spec.scalar_type = scalar_type.map(str::to_owned);
    let root = builder.push(spec).unwrap();
    builder.finish(root).unwrap().root_ref()
}

fn files(old: NodeRef, new: NodeRef) -> Vec<FileChanges> {
    vec![
        FileChanges {
            file_path: "old.dat".to_owned(),
            actions: vec![EditAction::Delete {
                node: old,
                context: vec![],
            }],
        },
        FileChanges {
            file_path: "new.dat".to_owned(),
            actions: vec![EditAction::Insert {
                parent: new.clone(),
                node: new,
                position: 0,
                context: vec![],
            }],
        },
    ]
}

#[test]
fn eager_and_lazy_moves_never_compare_hex_bytes_with_decoded_text() {
    for (old_type, new_type) in [
        (Some("bytes"), None),
        (None, Some("bytes")),
        (Some("first_encoding"), Some("second_encoding")),
    ] {
        let changes = files(
            file("old.dat", "ff", old_type),
            file("new.txt", "ff", new_type),
        );
        assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 0);
        let store = MemoryStore::new(&changes);
        assert_eq!(
            correlate_store(&store, CorrelateOptions::default())
                .unwrap()
                .len(),
            0
        );
    }
}

#[test]
fn exact_binary_renames_survive_but_binary_text_similarity_is_disabled() {
    let exact = files(
        file("old.bin", "ff01", Some("bytes")),
        file("new.bin", "ff01", Some("bytes")),
    );
    let modified = files(
        file("old.bin", "aa bb cc", Some("bytes")),
        file("new.bin", "aa bb dd", Some("bytes")),
    );
    let options = CorrelateOptions {
        rename_similarity_threshold: 0.1,
    };
    assert!(!correlate(&exact, options)[0].modified);
    assert!(!correlate_store(&MemoryStore::new(&exact), options).unwrap()[0].modified);
    assert_eq!(correlate(&modified, options).len(), 0);
    assert_eq!(
        correlate_store(&MemoryStore::new(&modified), options)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn eager_and_lazy_option_validation_agrees_including_exact_matches() {
    let changes = files(
        file("old.txt", "same content", None),
        file("new.txt", "same content", None),
    );
    for threshold in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1, 1.1] {
        let options = CorrelateOptions {
            rename_similarity_threshold: threshold,
        };
        assert_eq!(correlate(&changes, options).len(), 0);
        let store = MemoryStore::new(&changes);
        assert_eq!(correlate_store(&store, options).unwrap().len(), 0);
        assert_eq!(store.reads.get(), 0);
    }
    for threshold in [0.0, 1.0] {
        let options = CorrelateOptions {
            rename_similarity_threshold: threshold,
        };
        assert_eq!(correlate(&changes, options).len(), 1);
        assert_eq!(
            correlate_store(&MemoryStore::new(&changes), options)
                .unwrap()
                .len(),
            1
        );
    }
}

fn method(receiver: Option<&str>, body: &str, wrapped: bool) -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new("Method");
    spec.label = Some("Flush".to_owned());
    spec.match_key = receiver.map(str::to_owned);
    spec.value = Some(body.to_owned());
    let mut root = builder.push(spec).unwrap();
    if wrapped {
        let mut export = NodeSpec::new("Export");
        export.children.push(root);
        root = builder.push(export).unwrap();
    }
    builder.finish(root).unwrap().root_ref()
}

#[test]
fn fuzzy_receiver_methods_require_compatible_identity_hints_in_eager_and_lazy_stores() {
    for wrapped in [false, true] {
        for (old, new, expected) in [
            (Some("go::FirstWriter"), Some("go::SecondWriter"), 0),
            (Some("go::FirstWriter"), Some("go::FirstWriter"), 1),
            (Some("go::FirstWriter"), None, 1),
            (None, Some("go::SecondWriter"), 1),
            (None, None, 1),
        ] {
            let changes = files(
                method(old, "return common state original", wrapped),
                method(new, "return common state modified", wrapped),
            );
            let options = CorrelateOptions::default();
            let eager = correlate(&changes, options);
            let lazy = correlate_store(&MemoryStore::new(&changes), options).unwrap();
            assert_eq!(
                eager.len(),
                expected,
                "eager {old:?} -> {new:?}, wrapped={wrapped}"
            );
            assert_eq!(
                lazy.len(),
                expected,
                "lazy {old:?} -> {new:?}, wrapped={wrapped}"
            );
            if expected == 1 {
                assert!(eager[0].modified);
                assert!(lazy[0].modified);
            }
        }
    }
    // Hints are only fuzzy identity advice: identical verified content still
    // represents an exact move even if its owner hint changes.
    let changes = files(
        method(Some("go::FirstWriter"), "same body", false),
        method(Some("go::SecondWriter"), "same body", false),
    );
    assert!(!correlate(&changes, CorrelateOptions::default())[0].modified);
    assert!(
        !correlate_store(&MemoryStore::new(&changes), CorrelateOptions::default()).unwrap()[0]
            .modified
    );
}
