use differens_core::{
    EditAction, NodeContext, NodeRef, NodeSpec, SemanticChange, TreeBuilder, UpdateDetail,
};
use differens_narrate::{
    OutputFormat, format_changes, humanize_kind, narrate, narrate_action, readable_changes,
    summarize,
};

fn node(kind: &str, label: Option<&str>, value: Option<&str>) -> NodeRef {
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new(kind);
    spec.label = label.map(str::to_owned);
    spec.value = value.map(str::to_owned);
    let id = builder.push(spec).unwrap();
    NodeRef::new(builder.finish(id).unwrap(), id)
}
fn change(action: EditAction, path: Option<&str>) -> SemanticChange {
    SemanticChange {
        description: narrate_action(&action),
        action,
        file_path: path.map(str::to_owned),
        from_file_path: None,
        to_file_path: None,
        grouped: false,
    }
}
fn update(from: Option<&str>, to: Option<&str>) -> EditAction {
    EditAction::Update {
        node: node("leaf", Some("port"), to),
        detail: UpdateDetail::ValueChanged {
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
        },
        context: vec![],
    }
}
#[test]
fn all_value_and_move_narration_variants() {
    assert_eq!(
        narrate_action(&update(Some("1"), Some("2"))),
        "changed value of leaf `port` from `1` to `2`"
    );
    assert_eq!(
        narrate_action(&update(None, Some("2"))),
        "set value of leaf `port` to `2`"
    );
    assert_eq!(
        narrate_action(&update(Some("1"), None)),
        "removed value of leaf `port`"
    );
    assert_eq!(narrate_action(&update(None, None)), "modified leaf `port`");
    let n = node("Function", Some("go"), None);
    let action = EditAction::Move {
        node: n.clone(),
        from_parent: node("file", Some("old"), None),
        to_parent: node("file", Some("new"), None),
        from_position: 0,
        to_position: 3,
        context: vec![],
    };
    assert_eq!(
        narrate_action(&action),
        "moved function `go` from old to new"
    );
    let action = EditAction::Move {
        node: n.clone(),
        from_parent: node("block", None, None),
        to_parent: node("block", None, None),
        from_position: 0,
        to_position: 3,
        context: vec![],
    };
    assert_eq!(narrate_action(&action), "moved function `go` to position 4");
    let context = vec![NodeContext {
        kind: "Class".into(),
        label: Some("App".into()),
    }];
    assert_eq!(
        narrate_action(&EditAction::Delete {
            node: n.clone(),
            context: context.clone()
        }),
        "removed function `go` from class `App`"
    );
    assert_eq!(
        narrate_action(&EditAction::Insert {
            node: n.clone(),
            parent: n,
            position: 0,
            context
        }),
        "added function `go` in class `App`"
    );
}
#[test]
fn unicode_previews_are_safe_and_whitespace_normalized() {
    let action = EditAction::Delete {
        node: node("comment", None, Some(&"é🌍 ".repeat(60))),
        context: vec![],
    };
    let text = narrate_action(&action);
    assert!(text.ends_with("…`"));
    assert!(!text.contains("  "));
    assert_eq!(humanize_kind("CallExpression"), "call expression");
    assert_eq!(humanize_kind("call_expression"), "call expression");
    let action = EditAction::Delete {
        node: node("comment", None, Some(" \n \t")),
        context: vec![],
    };
    assert_eq!(narrate_action(&action), "removed comment");
}
#[test]
fn human_rollups_survive_repeated_formatting_and_limits() {
    let context = vec![NodeContext {
        kind: "Function".into(),
        label: Some("go".into()),
    }];
    let edits = (0..4)
        .map(|i| {
            change(
                EditAction::Update {
                    node: node("integer_literal", None, Some("2")),
                    detail: UpdateDetail::ValueChanged {
                        from: Some(i.to_string()),
                        to: Some("2".into()),
                    },
                    context: context.clone(),
                },
                Some("a.rs"),
            )
        })
        .collect::<Vec<_>>();
    let grouped = readable_changes(&edits, 20);
    assert_eq!(grouped.len(), 1);
    assert!(grouped[0].description.contains("4 updates"));
    assert_eq!(grouped, readable_changes(&grouped, 20));
    assert_eq!(summarize(&edits, true), "1 modification");
    let edits = (0..23)
        .map(|i| {
            change(
                EditAction::Delete {
                    node: node("Function", Some(&format!("fn{i}")), None),
                    context: vec![],
                },
                Some("a.rs"),
            )
        })
        .collect::<Vec<_>>();
    let limited = readable_changes(&edits, 20);
    assert_eq!(limited.len(), 21);
    assert!(limited[20].description.starts_with("3 more changes"));
}
#[test]
fn mixed_formats_are_valid_and_keep_file_order() {
    let changes = vec![
        change(update(Some("1"), Some("2")), Some("z.json")),
        change(update(None, Some("3")), Some("a.json")),
    ];
    let markdown = format_changes(&changes, OutputFormat::Markdown).unwrap();
    assert!(markdown.starts_with("## z.json"));
    assert!(markdown.contains("## a.json"));
    let terminal = format_changes(&changes, OutputFormat::Terminal).unwrap();
    assert!(terminal.starts_with("z.json\n"));
    let json = format_changes(&changes, OutputFormat::Json).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value.as_array().unwrap().len(), 2);
    assert!(value[0].get("grouped").is_none());
    let ndjson = format_changes(&changes, OutputFormat::Ndjson).unwrap();
    for line in ndjson.lines() {
        serde_json::from_str::<serde_json::Value>(line).unwrap();
    }
    for format in [
        OutputFormat::Terminal,
        OutputFormat::Markdown,
        OutputFormat::Json,
        OutputFormat::Llm,
        OutputFormat::Ndjson,
    ] {
        format_changes(&[], format).unwrap();
    }
    assert_eq!("json".parse::<OutputFormat>().unwrap(), OutputFormat::Json);
    assert!("invalid".parse::<OutputFormat>().is_err());
    assert_eq!(summarize(&[], false), "no logical changes");
}
#[test]
fn llm_rolls_up_anonymous_churn_and_preserves_moves() {
    let n = node("comment", None, Some("hello"));
    let m = node("Function", Some("moved"), None);
    let actions = vec![
        EditAction::Insert {
            node: n.clone(),
            parent: n,
            position: 0,
            context: vec![],
        },
        EditAction::Move {
            node: m.clone(),
            from_parent: node("file", Some("old"), None),
            to_parent: m,
            from_position: 0,
            to_position: 0,
            context: vec![],
        },
    ];
    let narrated = narrate(&actions, Some("a.rs"));
    let llm = format_changes(&narrated, OutputFormat::Llm).unwrap();
    assert!(llm.contains("* 1 comment"));
    assert!(llm.contains("> function moved from old"));
    let anonymous = change(
        EditAction::Update {
            node: node("word", None, Some("new")),
            detail: UpdateDetail::ValueChanged {
                from: Some("old".into()),
                to: Some("new".into()),
            },
            context: vec![],
        },
        None,
    );
    assert_eq!(readable_changes(&[anonymous], 20).len(), 1);
}
