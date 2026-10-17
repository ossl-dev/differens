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
        }
    }
}

impl CandidateStore for MemoryStore {
    type Error = Infallible;
    fn len(&self) -> usize {
        self.nodes.len()
    }
    fn metadata(&self, index: usize) -> Result<CandidateMeta, Self::Error> {
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
