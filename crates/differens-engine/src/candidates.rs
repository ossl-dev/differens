//! Budgeted candidate ownership. Small reports stay in memory; crossing the
//! budget spills the entire candidate cache before admitting another tree.

use std::{cell::Cell, collections::HashMap, io, mem::size_of};

use differens_core::{EditAction, Node, NodeId, NodeRef};
use differens_correlate::{
    ActionId, CandidateGroup, CandidateIndices, CandidateMeta, CandidateStore, StructureGroups,
};

use crate::{Error, Result, spill::CandidateSpool};

const DEFAULT_MEMORY_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn name_hash(label: Option<&str>) -> u64 {
    label.map_or(0, differens_core::hash_text)
}

pub(crate) fn metadata(id: ActionId, file: &str, action: &EditAction) -> CandidateMeta {
    let node = action.node();
    let named = if node.label.is_some() {
        node.clone()
    } else {
        node.children()
            .find(|child| child.label.is_some())
            .unwrap_or_else(|| node.clone())
    };
    CandidateMeta {
        id,
        file: file.to_owned(),
        kind: node.kind.clone(),
        label: named.label.clone(),
        structure_hash: node.structure_hash,
        exact_key: if node.kind == "file" {
            node.value
                .as_deref()
                .map_or(node.content_hash, differens_core::hash_text)
        } else {
            node.content_hash
        },
        deleted: matches!(action, EditAction::Delete { .. }),
    }
}

struct Entry {
    meta: CandidateMeta,
    node: NodeRef,
    claimed: Cell<bool>,
}

#[derive(Default)]
struct MemoryStore {
    entries: Vec<Entry>,
    groups: Vec<u64>,
    deletions: HashMap<u64, Vec<usize>>,
    insertions: HashMap<u64, Vec<usize>>,
    exact: HashMap<u64, Vec<usize>>,
    named: HashMap<(u64, u64), Vec<usize>>,
    retained: usize,
}

fn retained_bytes(meta: &CandidateMeta, node: &NodeRef) -> usize {
    // Account for payload allocations plus a conservative allowance for entry,
    // hash-table, and vector capacity growth. Projection never pins sibling ASTs.
    let mut bytes = 5 * size_of::<Entry>()
        + meta.file.len()
        + meta.kind.len()
        + meta.label.as_ref().map_or(0, String::len);
    // Include detached span maps and sparse identities in the retained budget.
    bytes = bytes.saturating_add(node.tree.auxiliary_heap_bytes());
    for index in node.id.0 + 1 - node.size..=node.id.0 {
        let node = node.tree.node(NodeId(index));
        bytes = bytes
            // Native adapter arenas grow geometrically; include spare node
            // capacity and allocator overhead alongside the owned field buffers.
            .saturating_add(2 * size_of::<Node>() + 64)
            .saturating_add(node.children.capacity().saturating_mul(size_of::<NodeId>()))
            .saturating_add(node.kind.capacity());
        for value in [&node.label, &node.value, &node.scalar_type]
            .into_iter()
            .flatten()
        {
            bytes = bytes.saturating_add(value.capacity());
        }
    }
    bytes
}

impl MemoryStore {
    fn push(&mut self, meta: CandidateMeta, node: NodeRef, bytes: usize) {
        let index = self.entries.len();
        if meta.deleted {
            if !self.deletions.contains_key(&meta.structure_hash) {
                self.groups.push(meta.structure_hash);
            }
            self.deletions
                .entry(meta.structure_hash)
                .or_default()
                .push(index);
        } else {
            self.insertions
                .entry(meta.structure_hash)
                .or_default()
                .push(index);
            self.exact.entry(meta.exact_key).or_default().push(index);
            self.named
                .entry((meta.structure_hash, name_hash(meta.label.as_deref())))
                .or_default()
                .push(index);
        }
        self.entries.push(Entry {
            meta,
            node,
            claimed: Cell::new(false),
        });
        self.retained = self.retained.saturating_add(bytes);
    }

    fn entry(&self, index: usize) -> Result<&Entry> {
        self.entries.get(index).ok_or_else(|| {
            Error::Spill(io::Error::new(
                io::ErrorKind::InvalidInput,
                "candidate index out of range",
            ))
        })
    }
}

impl CandidateStore for MemoryStore {
    type Error = Error;
    fn len(&self) -> usize {
        self.entries.len()
    }
    fn metadata(&self, index: usize) -> Result<CandidateMeta> {
        Ok(self.entry(index)?.meta.clone())
    }
    fn load(&self, index: usize) -> Result<NodeRef> {
        Ok(self.entry(index)?.node.clone())
    }
    fn groups(&self) -> Result<StructureGroups<'_, Error>> {
        Ok(Box::new(self.groups.iter().copied().map(Ok)))
    }
    fn candidates(&self, group: CandidateGroup) -> Result<CandidateIndices<'_, Error>> {
        let ids = match group {
            CandidateGroup::Deletions(hash) => self.deletions.get(&hash),
            CandidateGroup::Insertions(hash) => self.insertions.get(&hash),
            CandidateGroup::ExactInsertions(hash) => self.exact.get(&hash),
        };
        Ok(Box::new(
            ids.map_or(&[][..], Vec::as_slice).iter().copied().map(Ok),
        ))
    }
    fn is_claimed(&self, index: usize) -> Result<bool> {
        Ok(self.entry(index)?.claimed.get())
    }
    fn named_candidates<'a>(
        &'a self,
        structure_hash: u64,
        label: Option<&'a str>,
    ) -> Result<CandidateIndices<'a, Error>> {
        let ids = self.named.get(&(structure_hash, name_hash(label)));
        Ok(Box::new(
            ids.map_or(&[][..], Vec::as_slice).iter().copied().map(Ok),
        ))
    }
    fn claim(&self, index: usize) -> Result<()> {
        self.entry(index)?.claimed.set(true);
        Ok(())
    }
}

enum Storage {
    Memory(MemoryStore),
    Disk(CandidateSpool),
}

pub(crate) struct CandidateStorage {
    storage: Storage,
    budget: usize,
}

impl Default for CandidateStorage {
    fn default() -> Self {
        Self {
            storage: Storage::Memory(MemoryStore::default()),
            budget: DEFAULT_MEMORY_BYTES,
        }
    }
}

impl CandidateStorage {
    pub(crate) fn push(&mut self, id: ActionId, file: &str, action: &EditAction) -> Result<()> {
        let meta = metadata(id, file, action);
        let node = action.node().detached();
        let bytes = retained_bytes(&meta, &node);
        if let Storage::Memory(memory) = &self.storage {
            if memory.retained.saturating_add(bytes) > self.budget {
                let mut disk = CandidateSpool::new()?;
                for (index, entry) in memory.entries.iter().enumerate() {
                    disk.push_meta(&entry.meta, &entry.node)?;
                    if entry.claimed.get() {
                        disk.claim(index)?;
                    }
                }
                self.storage = Storage::Disk(disk);
            }
        }
        match &mut self.storage {
            Storage::Memory(memory) => memory.push(meta, node, bytes),
            Storage::Disk(disk) => disk.push_meta(&meta, &node)?,
        }
        Ok(())
    }
}

impl CandidateStore for CandidateStorage {
    type Error = Error;
    fn len(&self) -> usize {
        match &self.storage {
            Storage::Memory(memory) => memory.len(),
            Storage::Disk(disk) => disk.len(),
        }
    }
    fn metadata(&self, index: usize) -> Result<CandidateMeta> {
        match &self.storage {
            Storage::Memory(memory) => memory.metadata(index),
            Storage::Disk(disk) => disk.metadata(index),
        }
    }
    fn load(&self, index: usize) -> Result<NodeRef> {
        match &self.storage {
            Storage::Memory(memory) => memory.load(index),
            Storage::Disk(disk) => disk.load(index),
        }
    }
    fn groups(&self) -> Result<StructureGroups<'_, Error>> {
        match &self.storage {
            Storage::Memory(memory) => memory.groups(),
            Storage::Disk(disk) => disk.groups(),
        }
    }
    fn candidates(&self, group: CandidateGroup) -> Result<CandidateIndices<'_, Error>> {
        match &self.storage {
            Storage::Memory(memory) => memory.candidates(group),
            Storage::Disk(disk) => disk.candidates(group),
        }
    }
    fn is_claimed(&self, index: usize) -> Result<bool> {
        match &self.storage {
            Storage::Memory(memory) => memory.is_claimed(index),
            Storage::Disk(disk) => disk.is_claimed(index),
        }
    }
    fn named_candidates<'a>(
        &'a self,
        structure_hash: u64,
        label: Option<&'a str>,
    ) -> Result<CandidateIndices<'a, Error>> {
        match &self.storage {
            Storage::Memory(memory) => memory.named_candidates(structure_hash, label),
            Storage::Disk(disk) => disk.named_candidates(structure_hash, label),
        }
    }
    fn claim(&self, index: usize) -> Result<()> {
        match &self.storage {
            Storage::Memory(memory) => memory.claim(index),
            Storage::Disk(disk) => disk.claim(index),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use differens_core::{NodeSpec, TreeBuilder};
    use differens_correlate::{CorrelateOptions, correlate_store};

    fn node(kind: &str, name: &str, value: &str) -> NodeRef {
        let mut builder = TreeBuilder::new();
        let mut spec = NodeSpec::new(kind);
        spec.label = Some(name.to_owned());
        spec.value = Some(value.to_owned());
        let root = builder.push(spec).unwrap();
        builder.finish(root).unwrap().root_ref()
    }

    fn deleted(node: NodeRef) -> EditAction {
        EditAction::Delete {
            node,
            context: Vec::new(),
        }
    }
    fn inserted(node: NodeRef) -> EditAction {
        EditAction::Insert {
            parent: node.clone(),
            node,
            position: 0,
            context: Vec::new(),
        }
    }

    #[test]
    fn spill_before_oversized_candidate_preserves_exact_move_and_claims() {
        let mut storage = CandidateStorage {
            budget: 0,
            ..CandidateStorage::default()
        };
        storage
            .push(
                ActionId { file: 0, action: 0 },
                "old.rs",
                &deleted(node("Function", "check", "body")),
            )
            .unwrap();
        assert!(matches!(storage.storage, Storage::Disk(_)));
        storage
            .push(
                ActionId { file: 1, action: 0 },
                "new.rs",
                &inserted(node("Function", "check", "body")),
            )
            .unwrap();
        let moves = correlate_store(&storage, CorrelateOptions::default()).unwrap();
        assert_eq!(moves.len(), 1);
        assert!(storage.is_claimed(1).unwrap());
    }

    #[test]
    fn cache_transition_preserves_earlier_records_and_claim_bits() {
        let mut storage = CandidateStorage::default();
        storage
            .push(
                ActionId { file: 0, action: 0 },
                "first.rs",
                &inserted(node("Function", "first", "old")),
            )
            .unwrap();
        storage.claim(0).unwrap();
        if let Storage::Memory(memory) = &storage.storage {
            storage.budget = memory.retained;
        }
        storage
            .push(
                ActionId { file: 1, action: 0 },
                "second.rs",
                &deleted(node("Function", "second", "new")),
            )
            .unwrap();
        assert!(matches!(storage.storage, Storage::Disk(_)));
        assert_eq!(storage.len(), 2);
        assert!(storage.is_claimed(0).unwrap());
        assert_eq!(storage.load(0).unwrap().label.as_deref(), Some("first"));
        assert_eq!(storage.metadata(1).unwrap().file, "second.rs");
        let structure = storage.metadata(0).unwrap().structure_hash;
        assert_eq!(
            storage
                .named_candidates(structure, Some("first"))
                .unwrap()
                .collect::<Result<Vec<_>>>()
                .unwrap(),
            [0]
        );
    }

    #[test]
    fn memory_name_index_preserves_order_without_scanning_unrelated_names() {
        let mut storage = CandidateStorage::default();
        for index in 0..100 {
            let name = if [3, 70].contains(&index) {
                "wanted"
            } else {
                "other"
            };
            storage
                .push(
                    ActionId {
                        file: index,
                        action: 0,
                    },
                    &format!("{index}.rs"),
                    &inserted(node("Function", name, "value")),
                )
                .unwrap();
        }
        let structure = storage.metadata(0).unwrap().structure_hash;
        let indexes = storage
            .named_candidates(structure, Some("wanted"))
            .unwrap()
            .collect::<Result<Vec<_>>>()
            .unwrap();
        assert_eq!(indexes, [3, 70]);
        assert_eq!(
            storage.named_candidates(structure, None).unwrap().count(),
            0
        );
        assert_eq!(
            storage
                .named_candidates(structure, Some("missing"))
                .unwrap()
                .count(),
            0
        );
        assert!(matches!(storage.storage, Storage::Memory(_)));
    }

    #[test]
    fn in_memory_candidates_do_not_pin_unrelated_source_tree() {
        let mut builder = TreeBuilder::new();
        let mut function = NodeSpec::new("Function");
        function.label = Some("kept".into());
        let function = builder.push(function).unwrap();
        let mut unrelated = NodeSpec::new("Comment");
        unrelated.value = Some("x".repeat(100_000));
        let unrelated = builder.push(unrelated).unwrap();
        let mut root = NodeSpec::new("Program");
        root.children = vec![function, unrelated];
        let root = builder.push(root).unwrap();
        let tree = builder.finish(root).unwrap();
        let owner = std::sync::Arc::downgrade(&tree);
        let candidate = deleted(NodeRef::new(tree, function));
        let mut storage = CandidateStorage::default();
        storage
            .push(ActionId { file: 0, action: 0 }, "source.ts", &candidate)
            .unwrap();
        drop(candidate);
        assert!(owner.upgrade().is_none());
        assert_eq!(storage.load(0).unwrap().tree.len(), 1);
        assert!(matches!(storage.storage, Storage::Memory(_)));
    }

    #[test]
    fn detached_unicode_maps_stay_small_and_are_included_in_the_budget() {
        let source = "😀".repeat(100_000);
        let mut builder = TreeBuilder::with_source(&source);
        let mut function = NodeSpec::new("Function");
        function.byte_range = [source.len() - 4, source.len()];
        let root = builder.push(function).unwrap();
        let node = NodeRef::new(builder.finish(root).unwrap(), root);
        assert!(node.tree.auxiliary_heap_bytes() > 1024 * 1024);
        let mut storage = CandidateStorage {
            budget: 1024 * 1024,
            ..CandidateStorage::default()
        };
        storage
            .push(
                ActionId { file: 0, action: 0 },
                "unicode.ts",
                &deleted(node.clone()),
            )
            .unwrap();
        assert!(matches!(storage.storage, Storage::Memory(_)));
        let compact = storage.load(0).unwrap();
        let auxiliary = compact.tree.auxiliary_heap_bytes();
        assert!((1..1024).contains(&auxiliary));
        assert_eq!(
            serde_json::to_value(&compact).unwrap(),
            serde_json::to_value(&node).unwrap()
        );

        // A budget allowing the node alone but not its compact span map spills.
        let action = deleted(node);
        let meta = metadata(ActionId { file: 0, action: 0 }, "unicode.ts", &action);
        let mut tight = CandidateStorage {
            budget: retained_bytes(&meta, &compact) - auxiliary / 2,
            ..CandidateStorage::default()
        };
        tight
            .push(ActionId { file: 0, action: 0 }, "unicode.ts", &action)
            .unwrap();
        assert!(matches!(tight.storage, Storage::Disk(_)));
    }

    #[test]
    fn memory_store_missing_indices_return_errors_and_missing_buckets_are_empty() {
        let storage = CandidateStorage::default();
        assert_eq!(storage.len(), 0);
        assert!(storage.metadata(0).is_err());
        assert!(storage.load(0).is_err());
        assert!(storage.is_claimed(0).is_err());
        assert!(storage.claim(0).is_err());
        assert_eq!(storage.groups().unwrap().count(), 0);
        for group in [
            CandidateGroup::Deletions(1),
            CandidateGroup::Insertions(1),
            CandidateGroup::ExactInsertions(1),
        ] {
            assert_eq!(storage.candidates(group).unwrap().count(), 0);
        }
    }
}
