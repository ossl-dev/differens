use differens_core::{
    EditAction, MatchOptions, NodeId, NodeRef, NodeSpec, Tree, TreeBuilder, diff_trees, trees_equal,
};
use std::sync::Arc;

fn methods(value: &str) -> Arc<Tree> {
    let mut builder = TreeBuilder::new();
    let mut methods = Vec::new();
    for receiver in ["basicWriter", "flushWriter", "httpWriter", "fancyWriter"] {
        let mut body = NodeSpec::new("body");
        body.value = Some(format!("{value}-{receiver}"));
        let body = builder.push(body).unwrap();
        let mut method = NodeSpec::new("Method");
        method.label = Some("Flush".to_owned());
        method.match_key = Some(format!("go::{receiver}"));
        method.children.push(body);
        methods.push(builder.push(method).unwrap());
    }
    let mut root = NodeSpec::new("file");
    root.children = methods;
    let root = builder.push(root).unwrap();
    builder.finish(root).unwrap()
}

#[test]
fn receiver_identities_pair_same_named_methods_after_all_bodies_change() {
    let old = methods("before");
    let new = methods("after");
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert_eq!(result.changes.len(), 4);
    assert!(
        result
            .changes
            .iter()
            .all(|change| matches!(change, EditAction::Update { .. }))
    );
    for (index, change) in result.changes.iter().enumerate() {
        let method = change.node().parent().unwrap();
        assert_eq!(method.label.as_deref(), Some("Flush"));
        assert_eq!(
            method.match_key(),
            old.root_ref().children().nth(index).unwrap().match_key()
        );
    }
}

#[test]
fn identity_hints_are_not_hashed_or_considered_content() {
    fn one(key: Option<&str>) -> NodeRef {
        let mut builder = TreeBuilder::new();
        let mut spec = NodeSpec::new("Method");
        spec.label = Some("Flush".to_owned());
        spec.match_key = key.map(str::to_owned);
        let id = builder.push(spec).unwrap();
        builder.finish(id).unwrap().root_ref()
    }
    let with = one(Some("go::Writer"));
    let without = one(None);
    assert_eq!(with.content_hash, without.content_hash);
    assert_eq!(with.structure_hash, without.structure_hash);
    assert!(trees_equal(&with, &without));
    assert_eq!(without.tree.auxiliary_heap_bytes(), 0);
    assert!(with.tree.auxiliary_heap_bytes() > "go::Writer".len());
    #[cfg(feature = "serde")]
    assert_eq!(with.to_json().unwrap(), without.to_json().unwrap());
}

#[test]
fn detached_subtrees_and_projections_preserve_only_their_own_identity_keys() {
    let tree = methods("before");
    let method = tree.root_ref().children().nth(3).unwrap();
    for detached in [method.detached(), method.detached_shallow()] {
        assert_eq!(detached.match_key(), Some("go::fancyWriter"));
        assert_eq!(detached.tree.match_key(NodeId(99)), None);
        assert!(detached.tree.auxiliary_heap_bytes() < tree.auxiliary_heap_bytes());
        for child in detached.children() {
            assert_eq!(child.match_key(), None);
        }
    }
}

#[cfg(feature = "serde")]
#[test]
fn sparse_identities_round_trip_in_flat_storage_and_reject_invalid_ids() {
    let tree = methods("before");
    for node in [
        tree.root_ref(),
        tree.root_ref().children().nth(2).unwrap().detached(),
        tree.root_ref()
            .children()
            .nth(1)
            .unwrap()
            .detached_shallow(),
    ] {
        let snapshot = serde_json::to_vec(&node.snapshot()).unwrap();
        let restored = serde_json::from_slice::<differens_core::FlatSnapshot>(&snapshot)
            .unwrap()
            .into_node_ref()
            .unwrap();
        assert_eq!(restored.to_json().unwrap(), node.to_json().unwrap());
        assert_eq!(restored.match_key(), node.match_key());
        for (left, right) in restored.children().zip(node.children()) {
            assert_eq!(left.match_key(), right.match_key());
        }
    }
    let mut malformed = serde_json::to_value(tree.root_ref().snapshot()).unwrap();
    malformed["match_keys"]["999"] = serde_json::json!("outside_tree");
    assert!(
        serde_json::from_value::<differens_core::FlatSnapshot>(malformed)
            .unwrap()
            .into_node_ref()
            .is_err()
    );
}
