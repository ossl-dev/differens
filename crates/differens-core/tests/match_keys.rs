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

fn flush_methods_with_helper(after: bool) -> Arc<Tree> {
    fn call(builder: &mut TreeBuilder, receiver: &str, field: &str) -> NodeId {
        let mut object = NodeSpec::new("identifier");
        object.value = Some(receiver.to_owned());
        let object = builder.push(object).unwrap();
        let mut name = NodeSpec::new("field_identifier");
        name.value = Some(field.to_owned());
        let name = builder.push(name).unwrap();
        let mut call = NodeSpec::new("call");
        call.children = vec![object, name];
        builder.push(call).unwrap()
    }
    fn method(builder: &mut TreeBuilder, receiver: &str, name: &str, after: bool) -> NodeId {
        let mut parameter = NodeSpec::new("receiver_type");
        parameter.value = Some(receiver.to_owned());
        let parameter = builder.push(parameter).unwrap();
        let mut identifier = NodeSpec::new("identifier");
        identifier.value = Some(name.to_owned());
        let identifier = builder.push(identifier).unwrap();
        let calls = if name == "flush" {
            vec![
                call(builder, "b", "maybeWriteHeader"),
                call(builder, "b", "Flush"),
            ]
        } else if after {
            vec![call(builder, "f", "flush")]
        } else {
            vec![
                call(builder, "f", "wroteHeader"),
                call(builder, "fl", "Flush"),
            ]
        };
        let mut body = NodeSpec::new("statement_list");
        body.children = calls;
        let body = builder.push(body).unwrap();
        let mut method = NodeSpec::new("Method");
        method.label = Some(name.to_owned());
        method.match_key = Some(format!("go::{receiver}"));
        method.children = vec![parameter, identifier, body];
        builder.push(method).unwrap()
    }
    let mut builder = TreeBuilder::new();
    let mut methods = Vec::new();
    if after {
        methods.push(method(&mut builder, "basicWriter", "flush", true));
    }
    for receiver in [
        "flushWriter",
        "flushHijackWriter",
        "httpFancyWriter",
        "http2FancyWriter",
    ] {
        methods.push(method(&mut builder, receiver, "Flush", after));
    }
    let mut file = NodeSpec::new("file");
    file.children = methods;
    let root = builder.push(file).unwrap();
    builder.finish(root).unwrap()
}

#[test]
fn added_helper_cannot_steal_identical_bodies_from_other_receiver_methods() {
    let old = flush_methods_with_helper(false);
    let new = flush_methods_with_helper(true);
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    let mut edited_receivers = std::collections::BTreeSet::new();
    let mut added_helpers = 0;
    for change in &changes {
        if let EditAction::Insert { node, .. } = change {
            if node.kind == "Method" && node.label.as_deref() == Some("flush") {
                added_helpers += 1;
                continue;
            }
        }
        let mut current = Some(change.node().clone());
        while let Some(node) = current {
            if let Some(owner) = node.match_key() {
                assert_ne!(
                    owner, "go::basicWriter",
                    "new helper must only be inserted: {change:?}"
                );
                edited_receivers.insert(owner.to_owned());
                break;
            }
            current = node.parent();
        }
    }
    assert_eq!(added_helpers, 1);
    assert_eq!(
        edited_receivers,
        [
            "go::flushWriter",
            "go::flushHijackWriter",
            "go::httpFancyWriter",
            "go::http2FancyWriter"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
}

#[test]
fn receiver_hint_preserves_method_rename_and_identifier_update() {
    fn renamed(name: &str) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let mut identifier = NodeSpec::new("identifier");
        identifier.value = Some(name.to_owned());
        let identifier = builder.push(identifier).unwrap();
        let mut body = NodeSpec::new("body");
        body.value = Some("unchanged body".to_owned());
        let body = builder.push(body).unwrap();
        let mut method = NodeSpec::new("Method");
        method.label = Some(name.to_owned());
        method.match_key = Some("go::Writer".to_owned());
        method.children = vec![identifier, body];
        let method = builder.push(method).unwrap();
        let mut file = NodeSpec::new("file");
        file.children.push(method);
        let root = builder.push(file).unwrap();
        builder.finish(root).unwrap()
    }
    let changes = diff_trees(&renamed("Old"), &renamed("New"), MatchOptions::default()).changes;
    assert_eq!(changes.len(), 2);
    assert!(
        changes
            .iter()
            .all(|change| matches!(change, EditAction::Update { .. }))
    );
    assert!(changes.iter().any(|change| matches!(change, EditAction::Update {
        detail: differens_core::UpdateDetail::Renamed { from, to }, .. } if from=="Old" && to=="New")));
}

#[test]
fn hinted_helper_cannot_claim_tokens_from_unowned_declarations() {
    fn tree(hinted: bool) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let mut token = NodeSpec::new("identifier");
        token.value = Some("same".to_owned());
        let token = builder.push(token).unwrap();
        let mut declaration = NodeSpec::new(if hinted { "Method" } else { "Function" });
        declaration.label = Some("helper".to_owned());
        declaration.match_key = hinted.then(|| "go::Writer".to_owned());
        declaration.children.push(token);
        let declaration = builder.push(declaration).unwrap();
        let mut file = NodeSpec::new("file");
        file.children.push(declaration);
        let root = builder.push(file).unwrap();
        builder.finish(root).unwrap()
    }
    let changes = diff_trees(&tree(false), &tree(true), MatchOptions::default()).changes;
    assert_eq!(changes.len(), 2);
    assert!(
        changes.iter().any(
            |change| matches!(change, EditAction::Delete { node, .. } if node.kind=="Function")
        )
    );
    assert!(
        changes
            .iter()
            .any(|change| matches!(change, EditAction::Insert { node, .. } if node.kind=="Method"))
    );
}
