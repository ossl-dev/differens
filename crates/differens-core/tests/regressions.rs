use differens_core::{
    BuildError, EditAction, Fallback, MatchOptions, NodeId, NodeSpec, Tree, TreeBuilder,
    UpdateDetail, diff_trees, trees_equal,
};
use std::sync::Arc;

fn chain(depth: usize, value: &str) -> Arc<Tree> {
    let mut builder = TreeBuilder::with_capacity(depth);
    let mut leaf = NodeSpec::new("leaf");
    leaf.value = Some(value.to_owned());
    let mut root = builder.push(leaf).unwrap();
    for _ in 1..depth {
        let mut parent = NodeSpec::new("branch");
        parent.children.push(root);
        root = builder.push(parent).unwrap();
    }
    builder.finish(root).unwrap()
}

fn flat(labels: &[&str]) -> Arc<Tree> {
    let mut builder = TreeBuilder::new();
    let children = labels
        .iter()
        .map(|label| {
            let mut spec = NodeSpec::new("leaf");
            spec.label = Some((*label).to_owned());
            builder.push(spec).unwrap()
        })
        .collect();
    let mut root = NodeSpec::new("root");
    root.children = children;
    let root = builder.push(root).unwrap();
    builder.finish(root).unwrap()
}

#[test]
fn builder_rejects_shared_reordered_disconnected_and_invalid_nodes() {
    let mut builder = TreeBuilder::new();
    let a = builder.push(NodeSpec::new("a")).unwrap();
    let b = builder.push(NodeSpec::new("b")).unwrap();
    let mut parent = NodeSpec::new("parent");
    parent.children = vec![b, a];
    assert_eq!(
        builder.push(parent.clone()),
        Err(BuildError::NonContiguousChildren)
    );
    parent.children = vec![a, b];
    let p = builder.push(parent).unwrap();
    let mut shared = NodeSpec::new("shared");
    shared.children.push(a);
    assert_eq!(builder.push(shared), Err(BuildError::SharedChild(0)));
    assert!(builder.finish(p).is_ok());
    let mut disconnected = TreeBuilder::new();
    disconnected.push(NodeSpec::new("a")).unwrap();
    let root = disconnected.push(NodeSpec::new("b")).unwrap();
    assert_eq!(
        disconnected.finish(root).unwrap_err(),
        BuildError::InvalidRoot
    );
    let mut builder = TreeBuilder::new();
    let mut invalid = NodeSpec::new("bad");
    invalid.byte_range = [2, 1];
    assert_eq!(builder.push(invalid), Err(BuildError::InvalidRange));
    let mut invalid = NodeSpec::new("bad");
    invalid.line = Some(0);
    assert_eq!(builder.push(invalid), Err(BuildError::InvalidLine));
    let mut invalid = NodeSpec::new("bad");
    invalid.children = vec![NodeId(999)];
    assert_eq!(builder.push(invalid), Err(BuildError::InvalidChild(999)));
}

#[test]
fn two_hundred_thousand_deep_trees_build_match_compare_and_drop_on_small_stack() {
    std::thread::Builder::new().stack_size(128 * 1024).spawn(|| {
        let old = chain(200_000, "old");
        let identical = chain(200_000, "old");
        assert!(trees_equal(&old.root_ref(), &identical.root_ref()));
        assert_eq!(diff_trees(&old, &identical, MatchOptions::default()).changes, Vec::<EditAction>::new());
        drop(identical);
        let new = chain(200_000, "new");
        assert!(!trees_equal(&old.root_ref(), &new.root_ref()));
        let result = diff_trees(&old, &new, MatchOptions::default());
        assert_eq!(result.changes.len(), 1);
        assert!(matches!(&result.changes[0], EditAction::Update { detail: UpdateDetail::ValueChanged { from, to }, .. } if from.as_deref() == Some("old") && to.as_deref() == Some("new")));
        // Explicit drops happen inside the constrained-stack thread.
        drop(result); drop(old); drop(new);
    }).unwrap().join().unwrap();
}

#[test]
fn limits_preserve_input_node_counts_and_request_line_fallback() {
    let tree = flat(&["a", "b"]);
    let options = MatchOptions {
        max_nodes: 2,
        ..MatchOptions::default()
    };
    let result = diff_trees(&tree, &tree, options);
    assert_eq!(result.fallback, Some(Fallback::Lines));
    assert_eq!(result.node_count, 6);
    assert_eq!(result.changes, Vec::<EditAction>::new());
}

#[test]
fn sibling_rotation_produces_one_move_and_insert_delete_absorb_subtrees() {
    let old = flat(&["a", "b", "c"]);
    let new = flat(&["c", "a", "b"]);
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert_eq!(result.changes.len(), 1);
    assert!(matches!(
        &result.changes[0],
        EditAction::Move {
            from_position: 2,
            to_position: 0,
            ..
        }
    ));
    let empty = flat(&[]);
    let inserted = diff_trees(&empty, &chain(3, "x"), MatchOptions::default());
    assert_eq!(
        inserted
            .changes
            .iter()
            .filter(|action| matches!(action, EditAction::Insert { .. }))
            .count(),
        1
    );
    let removed = diff_trees(&chain(3, "x"), &empty, MatchOptions::default());
    assert_eq!(
        removed
            .changes
            .iter()
            .filter(|action| matches!(action, EditAction::Delete { .. }))
            .count(),
        1
    );
}

#[test]
fn types_preserve_changes_even_when_scalar_text_is_equal() {
    fn typed(kind: &str) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let mut leaf = NodeSpec::new("leaf");
        leaf.value = Some("1".to_owned());
        leaf.scalar_type = Some(kind.to_owned());
        let child = builder.push(leaf).unwrap();
        let mut root = NodeSpec::new("object");
        root.children.push(child);
        let root = builder.push(root).unwrap();
        builder.finish(root).unwrap()
    }
    let number = typed("number");
    let string = typed("string");
    assert_ne!(
        number.root_ref().content_hash,
        string.root_ref().content_hash
    );
    assert!(!trees_equal(&number.root_ref(), &string.root_ref()));
    let result = diff_trees(&number, &string, MatchOptions::default());
    assert_eq!(result.changes.len(), 1);
    assert!(matches!(&result.changes[0], EditAction::Update {
        detail: UpdateDetail::ValueChanged { from, to }, ..
    } if from.as_deref() == Some("1 (number)") && to.as_deref() == Some("1 (string)")));
}

#[cfg(feature = "serde")]
#[test]
fn serialization_is_deep_safe_and_shallow_projection_preserves_metadata() {
    std::thread::Builder::new()
        .stack_size(128 * 1024)
        .spawn(|| {
            let tree = chain(20_000, "😀\n\"\\\0");
            let root = tree.root_ref();
            let json = serde_json::to_string(&root).unwrap();
            assert_eq!(json.matches("\"kind\":").count(), 20_000);
            let shallow: serde_json::Value =
                serde_json::from_str(&root.shallow().to_json().unwrap()).unwrap();
            assert_eq!(
                shallow["children"].as_array().unwrap(),
                &Vec::<serde_json::Value>::new()
            );
            assert_eq!(shallow["height"], 20_000);
            drop(root);
            drop(tree);
        })
        .unwrap()
        .join()
        .unwrap();
}
