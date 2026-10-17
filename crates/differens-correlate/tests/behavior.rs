use differens_core::{EditAction, NodeContext, NodeRef, NodeSpec, TreeBuilder, UpdateDetail};
use differens_correlate::{ActionId, CorrelateOptions, FileChanges, correlate, is_move_candidate};

fn node(kind: &str, label: Option<&str>, value: Option<&str>) -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new(kind);
    spec.label = label.map(str::to_owned);
    spec.value = value.map(str::to_owned);
    spec.byte_range = [0, 10];
    let id = builder.push(spec).unwrap();
    NodeRef::new(builder.finish(id).unwrap(), id)
}

fn wrapped_function(name: &str, body: &str) -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut function = NodeSpec::new("Function");
    function.label = Some(name.to_owned());
    function.value = Some(body.to_owned());
    let child = builder.push(function).unwrap();
    let mut export = NodeSpec::new("Export");
    export.children.push(child);
    let id = builder.push(export).unwrap();
    NodeRef::new(builder.finish(id).unwrap(), id)
}

fn deletion(node: NodeRef) -> EditAction {
    EditAction::Delete {
        node,
        context: vec![],
    }
}

fn insertion(node: NodeRef) -> EditAction {
    EditAction::Insert {
        parent: node.clone(),
        node,
        position: 0,
        context: vec![],
    }
}

fn files(old: NodeRef, new: NodeRef) -> Vec<FileChanges> {
    vec![
        FileChanges {
            file_path: "a.ts".to_owned(),
            actions: vec![deletion(old)],
        },
        FileChanges {
            file_path: "b.ts".to_owned(),
            actions: vec![insertion(new)],
        },
    ]
}

#[test]
fn exact_move_preserves_source_action_identity_and_paths() {
    let old = node("Function", Some("foo"), None);
    let new = node("Function", Some("foo"), None);
    let result = correlate(&files(old, new), CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].from_file, "a.ts");
    assert_eq!(result[0].to_file, "b.ts");
    assert!(!result[0].modified);
    assert!((result[0].similarity - 1.0).abs() < f64::EPSILON);
    assert_eq!(result[0].deletion, ActionId { file: 0, action: 0 });
    assert_eq!(result[0].insertion, ActionId { file: 1, action: 0 });
}

#[test]
fn generic_types_and_unrelated_names_never_become_moves() {
    for (old, new) in [
        (
            node("generic_type", Some("Promise"), None),
            node("generic_type", Some("Promise"), None),
        ),
        (
            node(
                "Function",
                Some("readUser"),
                Some("return await db.find(id)"),
            ),
            node(
                "Function",
                Some("readOrder"),
                Some("return await db.find(id)"),
            ),
        ),
        (node("Block", None, None), node("Function", Some("f"), None)),
    ] {
        assert_eq!(
            correlate(&files(old, new), CorrelateOptions::default()).len(),
            0
        );
    }
}

#[test]
fn same_file_empty_and_unpaired_changes_produce_no_cross_file_moves() {
    let value = node("Function", Some("foo"), None);
    let mut changes = files(value.clone(), value.clone());
    changes[1].file_path = changes[0].file_path.clone();
    assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 0);
    changes.pop();
    assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 0);
    assert_eq!(correlate(&[], CorrelateOptions::default()).len(), 0);
}

#[test]
fn renamed_file_with_identical_contents_remains_an_exact_move() {
    let old = node("file", Some("old.ts"), Some("export const x = 1;"));
    let new = node("file", Some("new.ts"), Some("export const x = 1;"));
    assert_ne!(old.content_hash, new.content_hash);
    let result = correlate(&files(old, new), CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert!(!result[0].modified);
    assert!((result[0].similarity - 1.0).abs() < f64::EPSILON);
}

#[test]
fn edited_declaration_move_uses_jaccard_similarity() {
    let old = node(
        "Function",
        Some("validate"),
        Some("const a = 1; return check(a, input);"),
    );
    let new = node(
        "Function",
        Some("validate"),
        Some("const a = 1; return check(a, input, opts);"),
    );
    let result = correlate(&files(old, new), CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert!(result[0].modified);
    assert!(result[0].similarity >= 0.6 && result[0].similarity < 1.0);
}

#[test]
fn configurable_similarity_threshold_controls_modified_moves() {
    let changes = files(
        node("Function", Some("f"), Some("alpha beta gamma")),
        node("Function", Some("f"), Some("delta epsilon zeta")),
    );
    assert_eq!(
        correlate(
            &changes,
            CorrelateOptions {
                rename_similarity_threshold: 0.95
            }
        )
        .len(),
        0
    );
    assert_eq!(
        correlate(
            &changes,
            CorrelateOptions {
                rename_similarity_threshold: 0.01
            }
        )
        .len(),
        1
    );
}

#[test]
fn deletion_and_insertion_are_consumed_once_even_with_duplicate_nodes() {
    let old = node("Function", Some("f"), None);
    let new = node("Function", Some("f"), None);
    let mut changes = files(old, new);
    let duplicate = changes[1].actions[0].clone();
    changes[1].actions.push(duplicate);
    assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 1);
    let duplicate = changes[0].actions[0].clone();
    changes[0].actions.push(duplicate);
    let result = correlate(&changes, CorrelateOptions::default());
    assert_eq!(result.len(), 2);
    assert_ne!(result[0].deletion, result[1].deletion);
    assert_ne!(result[0].insertion, result[1].insertion);
}

#[test]
fn real_legacy_concatenation_hash_collision_is_verified_before_exact_matching() {
    // Legacy hashes concatenate label/value without a delimiter. Equal combined
    // text supplies a real collision without mutable nodes or injected hashes.
    let old = node("Function", Some("alpha"), Some("beta"));
    let new = node("Function", Some("alph"), Some("abeta"));
    assert_eq!(old.content_hash, new.content_hash);
    assert_eq!(
        correlate(&files(old, new), CorrelateOptions::default()).len(),
        0
    );
}

#[test]
fn file_similarity_excludes_path_tokens() {
    let old = node(
        "file",
        Some("src/helpers.ts"),
        Some("export function helper(x: number): number { return x * 2; }"),
    );
    let new = node(
        "file",
        Some("lib/util.ts"),
        Some("export function helper(x: number): number { return x * 3; }"),
    );
    let result = correlate(&files(old, new), CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert!(result[0].modified);
}

#[test]
fn export_wrapper_reports_its_named_declaration() {
    let changes = files(
        wrapped_function("fn79", "return x + 79;"),
        wrapped_function("fn79", "return x + 79;"),
    );
    let result = correlate(&changes, CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].node.kind, "Function");
    assert_eq!(result[0].node.label.as_deref(), Some("fn79"));
    assert!(!result[0].modified);
}

#[test]
fn local_variables_are_excluded_but_top_level_variables_and_empty_context_labels_are_not() {
    let value = node("Variable", Some("x"), Some("1"));
    let mut action = EditAction::Delete {
        node: value.clone(),
        context: vec![NodeContext {
            kind: "Function".to_owned(),
            label: Some("f".to_owned()),
        }],
    };
    assert!(!is_move_candidate(&action));
    action = EditAction::Delete {
        node: value,
        context: vec![NodeContext {
            kind: "Function".to_owned(),
            label: Some(String::new()),
        }],
    };
    assert!(is_move_candidate(&action));
}

#[test]
fn updates_are_never_cross_file_move_candidates() {
    let action = EditAction::Update {
        node: node("Function", Some("f"), None),
        detail: UpdateDetail::Renamed {
            from: "old".to_owned(),
            to: "f".to_owned(),
        },
        context: vec![],
    };
    assert!(!is_move_candidate(&action));
}

#[test]
fn large_structure_buckets_filter_by_name_before_similarity() {
    let old = node("Function", Some("target"), Some("one two three four"));
    let mut changes = vec![
        FileChanges {
            file_path: "old.ts".to_owned(),
            actions: vec![deletion(old)],
        },
        FileChanges {
            file_path: "new.ts".to_owned(),
            actions: vec![],
        },
    ];
    for index in 0..65 {
        changes[1].actions.push(insertion(node(
            "Function",
            Some(&format!("other{index}")),
            Some("one two three four five"),
        )));
    }
    changes[1].actions.push(insertion(node(
        "Function",
        Some("target"),
        Some("one two three five"),
    )));
    assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 1);
}

#[test]
fn more_than_sixty_four_ambiguous_similarity_candidates_stay_unpaired() {
    let old = node("Function", Some("target"), Some("one two three four"));
    let mut changes = files(
        old,
        node("Function", Some("target"), Some("one two three five")),
    );
    changes[1].actions = (0..65)
        .map(|_| insertion(node("Function", Some("target"), Some("one two three five"))))
        .collect();
    assert_eq!(correlate(&changes, CorrelateOptions::default()).len(), 0);
}

#[test]
fn unicode_case_conversion_precedes_ascii_token_splitting() {
    let changes = files(
        node("file", Some("a"), Some("\u{212a} \u{130}")),
        node("file", Some("b"), Some("k i")),
    );
    let result = correlate(&changes, CorrelateOptions::default());
    assert_eq!(result.len(), 1);
    assert!(result[0].modified);
    assert!((result[0].similarity - 1.0).abs() < f64::EPSILON);
}
