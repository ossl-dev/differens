use differens_core::{NodeRef, NodeSpec, TreeBuilder, trees_equal};
use std::sync::Arc;

fn tree() -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut leaf = NodeSpec::new("leaf");
    leaf.value = Some("1".to_owned());
    leaf.scalar_type = Some("number".to_owned());
    leaf.byte_range = [5, 6];
    leaf.line = Some(2);
    let leaf = builder.push(leaf).unwrap();
    let mut branch = NodeSpec::new("branch");
    branch.children.push(leaf);
    branch.label = Some("branch_name".to_owned());
    branch.emit_match_by_kind = true;
    let branch = builder.push(branch).unwrap();
    let other = builder.push(NodeSpec::new("unrelated")).unwrap();
    let mut root = NodeSpec::new("root");
    root.children = vec![branch, other];
    let root = builder.push(root).unwrap();
    builder.finish(root).unwrap().root_ref()
}

#[test]
fn detaching_keeps_only_subtree_and_releases_unrelated_owner() {
    let root = tree();
    let weak = Arc::downgrade(&root.tree);
    let child = root.children().next().unwrap();
    let detached = child.detached();
    assert_eq!(detached.tree.len(), 2);
    assert_eq!(detached.parent(), None);
    assert!(trees_equal(&child, &detached));
    assert_eq!(detached.content_hash, child.content_hash);
    assert_eq!(detached.structure_hash, child.structure_hash);
    assert_eq!(detached.height, child.height);
    drop(child);
    drop(root);
    assert!(weak.upgrade().is_none());
    assert_eq!(
        detached.children().next().unwrap().scalar_type.as_deref(),
        Some("number")
    );
}

#[test]
fn detached_projection_has_no_retained_child_capacity_or_source_owner() {
    let root = tree();
    let weak = Arc::downgrade(&root.tree);
    let projected = root.detached_shallow();
    assert_eq!(projected.tree.len(), 1);
    assert_eq!(projected.children.capacity(), 0);
    assert_eq!(projected.content_hash, root.content_hash);
    assert_eq!(projected.structure_hash, root.structure_hash);
    assert_eq!(projected.height, root.height);
    assert!(projected.is_shallow());
    drop(root);
    assert!(weak.upgrade().is_none());
}

#[test]
fn nonzero_base_subtree_detachment_reindexes_every_relative_edge() {
    let mut builder = TreeBuilder::new();
    let prefix = builder.push(NodeSpec::new("prefix")).unwrap();
    let first = builder.push(NodeSpec::new("first")).unwrap();
    let mut inner = NodeSpec::new("inner");
    inner.children.push(first);
    let inner = builder.push(inner).unwrap();
    let last = builder.push(NodeSpec::new("last")).unwrap();
    let mut branch = NodeSpec::new("branch");
    branch.children = vec![inner, last];
    let branch = builder.push(branch).unwrap();
    let mut root = NodeSpec::new("root");
    root.children = vec![prefix, branch];
    let root = builder.push(root).unwrap();
    let tree = builder.finish(root).unwrap();
    let original = NodeRef::new(Arc::clone(&tree), branch);
    assert_eq!(original.parent().unwrap(), tree.root_ref());
    assert_eq!(original.position, 1);
    let detached = original.detached();
    assert_eq!(detached.tree.len(), 4);
    assert_eq!(detached.position, 0);
    assert_eq!(detached.children[0].0, 1);
    assert_eq!(detached.children[1].0, 2);
    let inner = detached.children().next().unwrap();
    assert_eq!(inner.parent().unwrap(), detached);
    assert_eq!(inner.children[0].0, 0);
    assert_eq!(inner.children().next().unwrap().parent().unwrap(), inner);
    assert!(trees_equal(&original, &detached));
    let empty = detached.tree.is_empty();
    assert!(!empty);
    assert!(
        detached
            .tree
            .get(differens_core::NodeId(usize::MAX))
            .is_none()
    );
}

#[test]
#[should_panic(expected = "node ID belongs to tree")]
fn invalid_owned_references_fail_at_the_tree_boundary() {
    let root = tree();
    let _ = NodeRef::new(Arc::clone(&root.tree), differens_core::NodeId(usize::MAX));
}

#[cfg(feature = "serde")]
#[test]
fn snapshot_and_detached_serialization_preserve_exact_metadata() {
    for node in [tree(), tree().children().next().unwrap()] {
        for projection in [false, true] {
            let node = if projection {
                node.shallow()
            } else {
                node.clone()
            };
            let expected = node.to_json().unwrap();
            assert_eq!(node.detached().to_json().unwrap(), expected);
            let snapshot = serde_json::to_vec(&node.snapshot()).unwrap();
            let restored = serde_json::from_slice::<differens_core::FlatSnapshot>(&snapshot)
                .unwrap()
                .into_node_ref()
                .unwrap();
            assert_eq!(restored.to_json().unwrap(), expected);
            assert_eq!(restored.is_shallow(), projection);
            if !projection {
                assert!(trees_equal(&node, &restored));
            }
        }
    }
}

#[cfg(feature = "serde")]
#[test]
fn forged_flat_snapshot_topology_and_metadata_are_rejected() {
    let source = serde_json::to_value(tree().snapshot()).unwrap();
    let mut alterations = Vec::new();
    for key in ["height", "size", "contentHash", "structureHash", "position"] {
        let mut bad = source.clone();
        bad["nodes"][0][key] = serde_json::json!(999);
        alterations.push(bad);
    }
    let mut bad_parent = source.clone();
    bad_parent["nodes"][0]["parent"] = serde_json::json!(3);
    alterations.push(bad_parent);
    let mut cycle = source.clone();
    cycle["nodes"][0]["children"] = serde_json::json!([0]);
    alterations.push(cycle);
    let mut wrong_root = source.clone();
    wrong_root["root"] = serde_json::json!(0);
    alterations.push(wrong_root);
    let mut invalid_line = source;
    invalid_line["nodes"][0]["line"] = serde_json::json!(0);
    alterations.push(invalid_line);
    for bad in alterations {
        let snapshot = serde_json::from_value::<differens_core::FlatSnapshot>(bad).unwrap();
        assert!(snapshot.into_node_ref().is_err());
    }
}

#[cfg(feature = "serde")]
#[test]
fn invalid_shallow_snapshots_cannot_restore_full_or_invalid_metadata_arenas() {
    let source = serde_json::to_value(tree().shallow().snapshot()).unwrap();
    for (key, value) in [
        ("height", 0_u64),
        ("size", 2),
        ("position", 1),
        ("contentHash", 1 << 53),
        ("structureHash", 1 << 53),
    ] {
        let mut bad = source.clone();
        bad["nodes"][0][key] = serde_json::json!(value);
        let snapshot = serde_json::from_value::<differens_core::FlatSnapshot>(bad).unwrap();
        assert!(snapshot.into_node_ref().is_err());
    }
    let mut full_as_shallow = serde_json::to_value(tree().snapshot()).unwrap();
    full_as_shallow["shallow"] = serde_json::json!(true);
    assert!(
        serde_json::from_value::<differens_core::FlatSnapshot>(full_as_shallow)
            .unwrap()
            .into_node_ref()
            .is_err()
    );
    let mut empty = source;
    empty["nodes"] = serde_json::json!([]);
    assert!(
        serde_json::from_value::<differens_core::FlatSnapshot>(empty)
            .unwrap()
            .into_node_ref()
            .is_err()
    );
}

#[cfg(feature = "serde")]
#[test]
fn serialization_propagates_writer_failures() {
    struct FailedOutput;
    impl std::io::Write for FailedOutput {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("output unavailable"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let error = serde_json::to_writer(FailedOutput, &tree()).unwrap_err();
    assert!(error.is_io());
    assert!(error.to_string().contains("output unavailable"));
}

#[cfg(feature = "serde")]
#[test]
fn flat_snapshot_roundtrip_and_cleanup_are_deep_safe() {
    std::thread::Builder::new()
        .stack_size(128 * 1024)
        .spawn(|| {
            let mut builder = TreeBuilder::with_capacity(20_000);
            let mut root = builder.push(NodeSpec::new("leaf")).unwrap();
            for _ in 1..20_000 {
                let mut parent = NodeSpec::new("branch");
                parent.children.push(root);
                root = builder.push(parent).unwrap();
            }
            let original = builder.finish(root).unwrap().root_ref();
            let encoded = serde_json::to_vec(&original.snapshot()).unwrap();
            let snapshot =
                serde_json::from_slice::<differens_core::FlatSnapshot>(&encoded).unwrap();
            let restored = snapshot.into_node_ref().unwrap();
            assert!(trees_equal(&original, &restored));
            drop(original);
            drop(restored);
        })
        .unwrap()
        .join()
        .unwrap();
}
