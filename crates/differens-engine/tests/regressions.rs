use differens_core::EditAction;
use differens_engine::{diff_inline, report_file};
use differens_git::FilePair;
use differens_narrate::{OutputFormat, format_changes};

fn pair(old: &str, new: &str, extension: &str) -> FilePair {
    FilePair {
        old_path: format!("app.{extension}"),
        new_path: format!("app.{extension}"),
        old_source: old.as_bytes().to_vec(),
        new_source: new.as_bytes().to_vec(),
        old_exists: !old.is_empty(),
        new_exists: !new.is_empty(),
    }
}

fn terminal(input: &FilePair) -> String {
    format_changes(&diff_inline(input).unwrap().changes, OutputFormat::Terminal).unwrap()
}

#[test]
fn large_addition_is_one_fact_without_printing_body() {
    let source = (0..3000)
        .map(|index| format!("export const value{index} = {index};"))
        .collect::<Vec<_>>()
        .join("\n");
    let result = diff_inline(&pair("", &source, "ts")).unwrap();
    assert_eq!(result.changes.len(), 1);
    for format in [
        OutputFormat::Terminal,
        OutputFormat::Markdown,
        OutputFormat::Llm,
    ] {
        let output = format_changes(&result.changes, format).unwrap();
        assert!(output.len() < 100, "{output}");
        assert!(!output.contains("value2999"));
    }
}

#[test]
fn identical_data_value_changes_keep_both_property_identities() {
    let result = diff_inline(&pair(
        r#"{"port":1,"retries":1}"#,
        r#"{"port":2,"retries":2}"#,
        "json",
    ))
    .unwrap();
    assert_eq!(result.changes.len(), 2);
    let mut names: Vec<_> = result
        .changes
        .iter()
        .map(|change| change.action.node().label.as_deref().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["port", "retries"]);
}

#[test]
fn renamed_recursive_function_keeps_call_site_edit() {
    let result = diff_inline(&pair(
        "function before(){ return before(); }",
        "function after(){ return after(); }",
        "ts",
    ))
    .unwrap();
    assert_eq!(result.changes.len(), 2, "{:#?}", result.changes);
    assert!(
        result
            .changes
            .iter()
            .any(|change| change.action.node().kind == "Function")
    );
    assert!(
        result
            .changes
            .iter()
            .any(|change| change.action.node().kind == "identifier")
    );
}

#[test]
fn operators_keywords_and_typescript_dialects_keep_semantic_details() {
    for (before, after) in [("+", "-"), ("===", "!=="), ("&&", "||"), (">", ">=")] {
        let input = pair(
            &format!("function check(a,b){{ return a {before} b; }}"),
            &format!("function check(a,b){{ return a {after} b; }}"),
            "ts",
        );
        let output = terminal(&input);
        assert!(output.contains("function `check`"), "{output}");
        assert!(
            output.contains(&format!("`{before}` → `{after}`")),
            "{output}"
        );
        assert_eq!(output.lines().count(), 1);
    }
    assert_ne!(
        diff_inline(&pair("const value = 1;", "let value = 1;", "ts"))
            .unwrap()
            .changes,
        Vec::<differens_core::SemanticChange>::new()
    );
    for extension in ["mts", "cts"] {
        assert!(
            terminal(&pair(
                "export function run(){return 1}",
                "export function run(){return 2}",
                extension
            ))
            .contains("function `run`")
        );
    }
}

#[test]
fn rewrites_and_empty_existing_files_do_not_become_whole_file_removals() {
    let input = pair("function old(){return true}", "const other = [1,2,3]", "ts");
    let result = diff_inline(&input).unwrap();
    assert!(
        !result
            .changes
            .iter()
            .any(|change| matches!(change.action, EditAction::Delete { .. })
                && change.action.node().kind == "file")
    );
    let output = terminal(&input);
    assert!(output.contains("removed function `old`"), "{output}");
    assert!(output.contains("added variable `other`"), "{output}");
    let mut empty = pair("", "", "ts");
    empty.new_exists = true;
    assert!(matches!(
        diff_inline(&empty).unwrap().changes[0].action,
        EditAction::Insert { .. }
    ));
    let mut emptied = pair("function old(){}", "", "ts");
    emptied.new_exists = true;
    assert!(
        !diff_inline(&emptied)
            .unwrap()
            .changes
            .iter()
            .any(|change| change.action.node().kind == "file")
    );
}

#[test]
fn local_bindings_and_raw_rewrites_group_only_human_output() {
    let source = format!(
        "function run(){{ {} }}",
        (0..100)
            .map(|index| format!("const local{index} = {index};"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = terminal(&pair("function run(){}", &source, "ts"));
    assert!(output.contains("function `run`"), "{output}");
    assert!(!output.contains("added variable `local"), "{output}");
    assert!(output.lines().count() < 4, "{output}");
    let before = (0..100)
        .map(|index| format!("old-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let after = (0..100)
        .map(|index| format!("new-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let result = diff_inline(&pair(&before, &after, "md")).unwrap();
    assert!(result.changes.len() > 1);
    assert_eq!(
        format_changes(&result.changes, OutputFormat::Terminal)
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &format_changes(&result.changes, OutputFormat::Json).unwrap()
        )
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        result.changes.len()
    );
}

#[test]
fn insertion_parent_and_update_payloads_stay_shallow_and_proportional() {
    let methods = (0..120)
        .map(|index| format!("method{index}() {{ return {index}; }}"))
        .collect::<Vec<_>>()
        .join("\n");
    let result = diff_inline(&pair(
        "class Service { keep() { return true; } }",
        &format!("class Service {{ keep() {{ return true; }}\n{methods}\n}}"),
        "ts",
    ))
    .unwrap();
    assert_eq!(
        result
            .changes
            .iter()
            .filter(|change| matches!(change.action, EditAction::Insert { .. }))
            .count(),
        120
    );
    let json = serde_json::to_string(&result.changes).unwrap();
    assert!(json.len() < 250_000, "{}", json.len());
    let values: serde_json::Value = serde_json::from_str(&json).unwrap();
    for change in values.as_array().unwrap() {
        if change["action"]["type"] == "Insert" {
            assert_eq!(
                change["action"]["parent"]["children"],
                serde_json::json!([])
            );
        }
    }
    let source = |offset| {
        format!(
            "class Service {{\n{}\n}}",
            (0..120)
                .map(|index| format!("method{index}() {{ return {}; }}", index + offset))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let result = diff_inline(&pair(&source(0), &source(1000), "ts")).unwrap();
    assert!(result.changes.len() > 100);
    let json = serde_json::to_string(&result.changes).unwrap();
    assert!(json.len() < 120_000, "{}", json.len());
    let values: serde_json::Value = serde_json::from_str(&json).unwrap();
    for change in values.as_array().unwrap() {
        if ["Update", "Move"]
            .iter()
            .any(|kind| change["action"]["type"] == *kind)
        {
            assert_eq!(change["action"]["node"]["children"], serde_json::json!([]));
        }
    }
}

#[test]
fn standalone_empty_ndjson_has_no_invalid_prose() {
    let input = pair("const a=1", "const a=1", "ts");
    let mut output = Vec::new();
    report_file(&input, OutputFormat::Ndjson, &mut output, &mut Vec::new()).unwrap();
    assert_eq!(output, b"");
}

#[test]
fn standalone_renames_serialize_full_nodes_while_repository_payloads_are_shallow() {
    let input = pair(
        "function before(){ return 1; }",
        "function after(){ return 1; }",
        "ts",
    );
    let mut output = Vec::new();
    report_file(&input, OutputFormat::Json, &mut output, &mut Vec::new()).unwrap();
    let standalone: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert!(
        standalone[0]["action"]["node"]["children"]
            .as_array()
            .unwrap()
            .len()
            > 1
    );
    let repository = diff_inline(&input).unwrap();
    let repository: serde_json::Value = serde_json::to_value(&repository.changes).unwrap();
    assert_eq!(
        repository[0]["action"]["node"]["children"],
        serde_json::json!([])
    );
}
