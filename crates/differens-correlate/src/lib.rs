//! Deterministic cross-file declaration and whole-file move detection.
use differens_core::{EditAction, NodeRef, hash_text, trees_equal};
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
mod store;
pub use store::{
    CandidateGroup, CandidateIndices, CandidateMeta, CandidateStore, StructureGroups,
    correlate_store,
};

/// Stable identity of a source action within an ordered changeset.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ActionId {
    pub file: usize,
    pub action: usize,
}

/// A file's original edits, before presentation rollups.
#[derive(Clone, Debug)]
pub struct FileChanges {
    pub file_path: String,
    pub actions: Vec<EditAction>,
}

/// A one-to-one relocation across files.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFileMatch {
    #[serde(skip)]
    pub node: NodeRef,
    pub from_file: String,
    pub to_file: String,
    pub modified: bool,
    pub similarity: f64,
    #[serde(skip)]
    pub deletion: ActionId,
    #[serde(skip)]
    pub insertion: ActionId,
}

/// Correlation's conservative similarity threshold.
#[derive(Clone, Copy, Debug)]
pub struct CorrelateOptions {
    pub rename_similarity_threshold: f64,
}
impl Default for CorrelateOptions {
    fn default() -> Self {
        Self {
            rename_similarity_threshold: 0.6,
        }
    }
}
impl CorrelateOptions {
    fn is_valid(self) -> bool {
        self.rename_similarity_threshold.is_finite()
            && (0.0..=1.0).contains(&self.rename_similarity_threshold)
    }
}

fn movable(kind: &str) -> bool {
    matches!(
        kind,
        "file"
            | "Function"
            | "Method"
            | "Class"
            | "Interface"
            | "TypeDef"
            | "Enum"
            | "Struct"
            | "Trait"
            | "Module"
            | "Variable"
    )
}
fn named_node(node: &NodeRef) -> NodeRef {
    if node.label.is_some() {
        return node.clone();
    }
    node.children()
        .find(|child| child.label.is_some())
        .unwrap_or_else(|| node.clone())
}

/// Only declarations and complete files have meaningful cross-file identity.
#[must_use]
pub fn is_move_candidate(action: &EditAction) -> bool {
    if !matches!(
        action,
        EditAction::Insert { .. } | EditAction::Delete { .. }
    ) {
        return false;
    }
    let node = named_node(action.node());
    node.label.as_deref().is_some_and(|s| !s.is_empty())
        && movable(&node.kind)
        && (node.kind != "Variable"
            || !action.context().iter().any(|ctx| {
                movable(&ctx.kind)
                    && ctx.kind != "file"
                    && ctx.label.as_deref().is_some_and(|s| !s.is_empty())
            }))
}

#[derive(Clone, Copy)]
struct Candidate<'a> {
    id: ActionId,
    file: &'a str,
    node: &'a NodeRef,
}
fn exact_key(node: &NodeRef) -> u64 {
    if node.kind == "file" {
        node.value.as_deref().map_or(node.content_hash, hash_text)
    } else {
        node.content_hash
    }
}
fn tokens(node: &NodeRef) -> HashSet<String> {
    let mut result = HashSet::new();
    let include_label = node.kind != "file";
    let mut stack = vec![node.id];
    while let Some(id) = stack.pop() {
        let current = node.tree.node(id);
        for text in current
            .value
            .as_deref()
            .into_iter()
            .chain(if include_label {
                current.label.as_deref()
            } else {
                None
            })
        {
            for token in text
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .filter(|s| !s.is_empty())
            {
                result.insert(token.to_owned());
            }
        }
        stack.extend(current.children.iter().copied());
    }
    result
}
fn similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    let common = a.intersection(b).count();
    let union = a.len() + b.len() - common;
    if union == 0 {
        0.0
    } else {
        // Token sets cannot approach 2^53 entries in addressable process memory.
        #[allow(clippy::cast_precision_loss)]
        let score = common as f64 / union as f64;
        score
    }
}

fn compatible_file_similarity(old: &NodeRef, new: &NodeRef) -> bool {
    old.scalar_type == new.scalar_type && old.scalar_type.as_deref() != Some("bytes")
}

fn compatible_declaration_identity(old: &NodeRef, new: &NodeRef) -> bool {
    let old = named_node(old);
    let new = named_node(new);
    !matches!((old.match_key(), new.match_key()), (Some(old), Some(new)) if old != new)
}

#[derive(Default)]
struct TokenCache {
    deleted: HashMap<ActionId, HashSet<String>>,
    inserted: HashMap<ActionId, HashSet<String>>,
}

fn exact_insertion(
    deleted: Candidate<'_>,
    insertions: &[Candidate<'_>],
    candidates: Option<&Vec<usize>>,
    claimed: &[bool],
) -> Option<usize> {
    candidates.into_iter().flatten().copied().find(|&index| {
        let inserted = insertions[index];
        !claimed[index]
            && deleted.file != inserted.file
            && deleted.node.kind == inserted.node.kind
            && (trees_equal(deleted.node, inserted.node)
                || (deleted.node.kind == "file"
                    && deleted.node.value.is_some()
                    && deleted.node.scalar_type == inserted.node.scalar_type
                    && deleted.node.value == inserted.node.value))
    })
}

fn similar_insertion(
    deleted: Candidate<'_>,
    insertions: &[Candidate<'_>],
    group: &[usize],
    claimed: &[bool],
    cache: &mut TokenCache,
    threshold: f64,
) -> Option<(usize, f64)> {
    if deleted.node.kind == "file" && deleted.node.scalar_type.as_deref() == Some("bytes") {
        return None;
    }
    let name = named_node(deleted.node);
    let candidates: Vec<_> = group
        .iter()
        .copied()
        .filter(|&index| {
            group.len() <= 64 || named_node(insertions[index].node).label == name.label
        })
        .take(65)
        .collect();
    if candidates.len() > 64 {
        return None;
    }
    let old = cache
        .deleted
        .entry(deleted.id)
        .or_insert_with(|| tokens(deleted.node));
    let mut best = None;
    let mut score = 0.0;
    for index in candidates {
        let inserted = insertions[index];
        if claimed[index]
            || deleted.file == inserted.file
            || (deleted.node.kind != "file" && name.label != named_node(inserted.node).label)
            || (deleted.node.kind == "file"
                && !compatible_file_similarity(deleted.node, inserted.node))
            || !compatible_declaration_identity(deleted.node, inserted.node)
        {
            continue;
        }
        let candidate = similarity(
            old,
            cache
                .inserted
                .entry(inserted.id)
                .or_insert_with(|| tokens(inserted.node)),
        );
        if candidate > score {
            score = candidate;
            best = Some(index);
        }
    }
    best.filter(|_| score >= threshold)
        .map(|index| (index, score))
}

/// Find moves in input order, verifying content behind every exact hash match.
#[must_use]
pub fn correlate(files: &[FileChanges], options: CorrelateOptions) -> Vec<CrossFileMatch> {
    if !options.is_valid() {
        return Vec::new();
    }
    let mut deletions = Vec::new();
    let mut insertions = Vec::new();
    for (fi, file) in files.iter().enumerate() {
        for (ai, action) in file.actions.iter().enumerate() {
            if !is_move_candidate(action) {
                continue;
            }
            let candidate = Candidate {
                id: ActionId {
                    file: fi,
                    action: ai,
                },
                file: &file.file_path,
                node: action.node(),
            };
            if matches!(action, EditAction::Delete { .. }) {
                deletions.push(candidate);
            } else {
                insertions.push(candidate);
            }
        }
    }
    let mut del_buckets = IndexMap::<u64, Vec<usize>>::new();
    let mut ins_buckets = HashMap::<u64, Vec<usize>>::new();
    let mut exact_buckets = HashMap::<u64, Vec<usize>>::new();
    for (i, candidate) in deletions.iter().enumerate() {
        del_buckets
            .entry(candidate.node.structure_hash)
            .or_default()
            .push(i);
    }
    for (i, candidate) in insertions.iter().enumerate() {
        ins_buckets
            .entry(candidate.node.structure_hash)
            .or_default()
            .push(i);
        exact_buckets
            .entry(exact_key(candidate.node))
            .or_default()
            .push(i);
    }
    let mut claimed = vec![false; insertions.len()];
    let mut token_cache = TokenCache::default();
    let mut moves = Vec::new();
    for (structure, group) in del_buckets {
        let Some(ins_group) = ins_buckets.get(&structure) else {
            continue;
        };
        for di in group {
            let del = deletions[di];
            let matched = exact_insertion(
                del,
                &insertions,
                exact_buckets.get(&exact_key(del.node)),
                &claimed,
            )
            .map(|index| (index, 1.0, false))
            .or_else(|| {
                similar_insertion(
                    del,
                    &insertions,
                    ins_group,
                    &claimed,
                    &mut token_cache,
                    options.rename_similarity_threshold,
                )
                .map(|(index, score)| (index, score, true))
            });
            if let Some((ii, score, modified)) = matched {
                claimed[ii] = true;
                let ins = insertions[ii];
                moves.push(CrossFileMatch {
                    node: named_node(ins.node),
                    from_file: del.file.into(),
                    to_file: ins.file.into(),
                    modified,
                    similarity: score,
                    deletion: del.id,
                    insertion: ins.id,
                });
            }
        }
    }
    moves
}

#[cfg(test)]
mod tests {
    use super::*;
    use differens_core::{NodeSpec, TreeBuilder};
    fn node(name: &str, value: &str) -> NodeRef {
        let mut builder = TreeBuilder::new();
        let mut spec = NodeSpec::new("Function");
        spec.label = Some(name.into());
        spec.value = Some(value.into());
        let id = builder.push(spec).unwrap();
        NodeRef::new(builder.finish(id).unwrap(), id)
    }
    fn files(a: NodeRef, b: NodeRef) -> Vec<FileChanges> {
        vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![EditAction::Delete {
                    node: a,
                    context: vec![],
                }],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: vec![EditAction::Insert {
                    node: b.clone(),
                    parent: b,
                    position: 0,
                    context: vec![],
                }],
            },
        ]
    }
    #[test]
    fn detects_exact_and_modified_moves() {
        let changes = files(node("check", "same body"), node("check", "same body"));
        let result = correlate(&changes, CorrelateOptions::default());
        assert_eq!(result.len(), 1);
        assert!(!result[0].modified);
        assert_eq!(result[0].deletion.action, 0);
        let changes = files(
            node("check", "return input value alpha"),
            node("check", "return input value beta"),
        );
        let result = correlate(
            &changes,
            CorrelateOptions {
                rename_similarity_threshold: 0.5,
            },
        );
        assert_eq!(result.len(), 1);
        assert!(result[0].modified);
    }
    #[test]
    fn excludes_same_file_and_local_variables() {
        let mut changes = files(node("check", "same"), node("check", "same"));
        changes[1].file_path = "old.rs".into();
        assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 0);
    }
    #[test]
    fn assigns_each_insertion_only_once() {
        let mut changes = files(node("check", "same"), node("check", "same"));
        let duplicate = changes[0].actions[0].clone();
        changes[0].actions.push(duplicate);
        assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 1);
    }
}
