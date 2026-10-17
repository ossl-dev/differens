use differens_core::{
    EditAction, MatchOptions, NodeContext, NodeId, NodeSpec, Tree, TreeBuilder, UpdateDetail,
    diff_trees,
};
use std::sync::Arc;

struct Shape {
    kind: &'static str,
    label: Option<&'static str>,
    value: Option<&'static str>,
    children: Vec<Self>,
    match_by_kind: bool,
}

fn leaf(kind: &'static str, label: Option<&'static str>, value: Option<&'static str>) -> Shape {
    Shape {
        kind,
        label,
        value,
        children: vec![],
        match_by_kind: false,
    }
}

fn container(kind: &'static str, label: Option<&'static str>, children: Vec<Shape>) -> Shape {
    Shape {
        kind,
        label,
        value: None,
        children,
        match_by_kind: false,
    }
}

fn build(shape: Shape) -> Arc<Tree> {
    fn append(shape: Shape, builder: &mut TreeBuilder) -> NodeId {
        let children = shape
            .children
            .into_iter()
            .map(|child| append(child, builder))
            .collect();
        let mut spec = NodeSpec::new(shape.kind);
        spec.children = children;
        spec.label = shape.label.map(str::to_owned);
        spec.value = shape.value.map(str::to_owned);
        spec.match_by_kind = shape.match_by_kind;
        spec.byte_range = [0, 1];
        builder.push(spec).unwrap()
    }
    let mut builder = TreeBuilder::new();
    let root = append(shape, &mut builder);
    builder.finish(root).unwrap()
}

#[test]
fn postorder_metadata_and_hash_invariants_cover_every_descendant() {
    let tree = build(container(
        "root",
        None,
        vec![
            container(
                "fn",
                Some("a"),
                vec![leaf("name", Some("a"), None), leaf("num", None, Some("1"))],
            ),
            container("fn", Some("b"), vec![leaf("name", Some("b"), None)]),
        ],
    ));
    assert_eq!(tree.len(), 6);
    let root = tree.root_ref();
    assert_eq!(root.size, 6);
    assert_eq!(root.height, 3);
    assert_eq!(root.parent, None);
    assert_eq!(root.children, [NodeId(2), NodeId(4)]);
    for (position, child) in root.children().enumerate() {
        assert_eq!(child.parent, Some(root.id));
        assert_eq!(child.position, position);
    }
    let old = build(container(
        "fn",
        Some("foo"),
        vec![
            leaf("name", Some("foo"), None),
            leaf("num", None, Some("1")),
        ],
    ));
    let changed = build(container(
        "fn",
        Some("bar"),
        vec![
            leaf("name", Some("bar"), None),
            leaf("num", None, Some("2")),
        ],
    ));
    assert_eq!(
        old.root_ref().structure_hash,
        changed.root_ref().structure_hash
    );
    assert_ne!(old.root_ref().content_hash, changed.root_ref().content_hash);
    let reordered = build(container(
        "fn",
        Some("foo"),
        vec![
            leaf("num", None, Some("1")),
            leaf("name", Some("foo"), None),
        ],
    ));
    assert_ne!(
        old.root_ref().content_hash,
        reordered.root_ref().content_hash
    );
    assert_ne!(
        old.root_ref().structure_hash,
        reordered.root_ref().structure_hash
    );
}

#[test]
fn updates_keep_both_label_and_value_edits_in_postorder() {
    let old = build(container(
        "fn",
        Some("foo"),
        vec![leaf("name", Some("foo"), Some("1"))],
    ));
    let new = build(container(
        "fn",
        Some("bar"),
        vec![leaf("name", Some("bar"), Some("2"))],
    ));
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert_eq!(result.changes.len(), 3);
    assert!(
        matches!(&result.changes[0], EditAction::Update { node, detail: UpdateDetail::Renamed { from, to }, .. } if node.kind == "name" && from == "foo" && to == "bar")
    );
    assert!(
        matches!(&result.changes[1], EditAction::Update { detail: UpdateDetail::ValueChanged { from, to }, .. } if from.as_deref() == Some("1") && to.as_deref() == Some("2"))
    );
    assert!(
        matches!(&result.changes[2], EditAction::Update { node, detail: UpdateDetail::Renamed { .. }, .. } if node.kind == "fn")
    );
}

#[test]
fn optional_labels_and_values_preserve_absent_vs_empty() {
    for (old_label, new_label, from, to) in [
        (Some("foo"), None, "foo", "unnamed"),
        (None, Some("bar"), "unnamed", "bar"),
        (Some(""), None, "", "unnamed"),
    ] {
        let old = build(container(
            "fn",
            old_label,
            vec![leaf("id", Some("x"), None)],
        ));
        let new = build(container(
            "fn",
            new_label,
            vec![leaf("id", Some("x"), None)],
        ));
        let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
        assert_eq!(changes.len(), 1);
        assert!(
            matches!(&changes[0], EditAction::Update { detail: UpdateDetail::Renamed { from: actual_from, to: actual_to }, .. } if actual_from == from && actual_to == to)
        );
    }
    for (from, to) in [(None, Some("2")), (Some("1"), None), (None, Some(""))] {
        let old = build(leaf("root", None, from));
        let new = build(leaf("root", None, to));
        let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
        assert_eq!(changes.len(), 1);
        assert!(
            matches!(&changes[0], EditAction::Update { detail: UpdateDetail::ValueChanged { from: actual_from, to: actual_to }, .. } if actual_from.as_deref() == from && actual_to.as_deref() == to)
        );
    }
}

#[test]
fn unrelated_roots_and_rewrites_keep_legacy_subtree_absorption() {
    let old = build(leaf("old", Some("a"), None));
    let new = build(leaf("new", Some("a"), None));
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(changes.len(), 1);
    assert!(matches!(&changes[0], EditAction::Delete { .. }));
    let old = build(container(
        "program",
        None,
        vec![leaf("function", Some("foo"), None)],
    ));
    let new = build(container(
        "program",
        None,
        vec![leaf("class", Some("Bar"), None)],
    ));
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(changes.len(), 2);
    assert!(matches!(&changes[0], EditAction::Delete { node, .. } if node.kind == "function"));
    assert!(matches!(&changes[1], EditAction::Insert { node, .. } if node.kind == "class"));
}

#[test]
fn cross_parent_moves_preserve_exact_parents_and_positions() {
    let old = build(container(
        "program",
        None,
        vec![
            container(
                "container",
                None,
                vec![
                    leaf("leaf", Some("keep1"), None),
                    leaf("leaf", Some("keep2"), None),
                    leaf("leaf", Some("foo"), None),
                ],
            ),
            container(
                "container",
                None,
                vec![
                    leaf("leaf", Some("keep3"), None),
                    leaf("leaf", Some("keep4"), None),
                ],
            ),
        ],
    ));
    let new = build(container(
        "program",
        None,
        vec![
            container(
                "container",
                None,
                vec![
                    leaf("leaf", Some("keep1"), None),
                    leaf("leaf", Some("keep2"), None),
                ],
            ),
            container(
                "container",
                None,
                vec![
                    leaf("leaf", Some("keep3"), None),
                    leaf("leaf", Some("keep4"), None),
                    leaf("leaf", Some("foo"), None),
                ],
            ),
        ],
    ));
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(changes.len(), 1);
    assert!(
        matches!(&changes[0], EditAction::Move { node, from_parent, to_parent, from_position: 2, to_position: 2, .. } if node.label.as_deref() == Some("foo") && from_parent.id == old.root_ref().children[0] && to_parent.id == new.root_ref().children[1])
    );
}

#[test]
fn leaf_alignment_tracks_kind_insertions_without_smearing_values() {
    let old = build(container(
        "root",
        None,
        vec![
            leaf("anchor", None, Some("same")),
            leaf("a", None, Some("old_a")),
            leaf("b", None, Some("old_b")),
        ],
    ));
    let new = build(container(
        "root",
        None,
        vec![
            leaf("anchor", None, Some("same")),
            leaf("inserted", None, Some("new")),
            leaf("a", None, Some("new_a")),
            leaf("b", None, Some("new_b")),
        ],
    ));
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(changes.len(), 3);
    assert!(matches!(&changes[0], EditAction::Update { node, .. } if node.kind == "a"));
    assert!(matches!(&changes[1], EditAction::Update { node, .. } if node.kind == "b"));
    assert!(
        matches!(&changes[2], EditAction::Insert { node, position: 1, .. } if node.kind == "inserted")
    );
}

#[test]
fn unique_anonymous_match_by_kind_containers_survive_shape_changes() {
    let mut old_body = container("body", None, vec![leaf("old", None, Some("1"))]);
    old_body.match_by_kind = true;
    let mut new_body = container(
        "body",
        None,
        vec![
            leaf("new", None, Some("2")),
            leaf("Method", Some("added"), None),
        ],
    );
    new_body.match_by_kind = true;
    let old = build(container(
        "root",
        None,
        vec![container("Class", Some("C"), vec![old_body])],
    ));
    let new = build(container(
        "root",
        None,
        vec![container("Class", Some("C"), vec![new_body])],
    ));
    let changes = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(changes.len(), 3);
    assert!(
        changes
            .iter()
            .all(|change| change.node().kind != "body" && change.node().kind != "Class")
    );
    assert!(changes.iter().any(|change| matches!(change, EditAction::Insert { node, .. } if node.label.as_deref() == Some("added"))));
}

#[test]
fn ancestry_is_nearest_first_including_file_wrapper() {
    fn nested(value: &'static str) -> Arc<Tree> {
        build(container(
            "root",
            None,
            vec![container(
                "class",
                Some("Worker"),
                vec![container(
                    "fn",
                    Some("work"),
                    vec![leaf("num", None, Some(value))],
                )],
            )],
        ))
    }
    let changes = diff_trees(&nested("1"), &nested("2"), MatchOptions::default()).changes;
    assert_eq!(
        changes[0].context(),
        [
            NodeContext {
                kind: "fn".to_owned(),
                label: Some("work".to_owned())
            },
            NodeContext {
                kind: "class".to_owned(),
                label: Some("Worker".to_owned())
            },
            NodeContext {
                kind: "root".to_owned(),
                label: None
            }
        ]
    );
}

#[test]
fn wide_changed_leaves_recover_positionally_and_remain_deterministic() {
    fn wide(prefix: &str) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let mut children = Vec::new();
        for index in 0..150 {
            let mut spec = NodeSpec::new("leaf");
            spec.label = Some(format!("leaf{index}"));
            spec.value = Some(format!("{prefix}{index}"));
            children.push(builder.push(spec).unwrap());
        }
        let mut root = NodeSpec::new("root");
        root.children = children;
        let root = builder.push(root).unwrap();
        builder.finish(root).unwrap()
    }
    let old = wide("old");
    let new = wide("new");
    let expected = diff_trees(&old, &new, MatchOptions::default()).changes;
    assert_eq!(expected.len(), 150);
    assert!(expected.iter().all(|change| matches!(
        change,
        EditAction::Update {
            detail: UpdateDetail::ValueChanged { .. },
            ..
        }
    )));
    for _ in 0..5 {
        assert_eq!(
            diff_trees(&old, &new, MatchOptions::default()).changes,
            expected
        );
    }
}

#[test]
fn default_core_limit_still_accepts_more_than_three_hundred_thousand_nodes() {
    let mut builder = TreeBuilder::with_capacity(300_001);
    let children = (0..300_000)
        .map(|_| builder.push(NodeSpec::new("leaf")).unwrap())
        .collect();
    let mut root = NodeSpec::new("root");
    root.children = children;
    let root = builder.push(root).unwrap();
    let tree = builder.finish(root).unwrap();
    let result = diff_trees(&tree, &tree, MatchOptions::default());
    assert_eq!(result.node_count, 600_002);
    assert_eq!(result.fallback, None);
    assert_eq!(result.changes, Vec::<EditAction>::new());
}
