use std::{fs, io};

use differens_engine::{DiffEngine, ReportOptions, diff_inline, load_config, report, report_file};
use differens_git::FilePair;
use differens_narrate::OutputFormat;
use tempfile::tempdir;

fn pair(path: &str, old: &str, new: &str) -> FilePair {
    FilePair {
        old_path: path.into(),
        new_path: path.into(),
        old_source: old.as_bytes().to_vec(),
        new_source: new.as_bytes().to_vec(),
        old_exists: !old.is_empty(),
        new_exists: !new.is_empty(),
    }
}

fn rendered(inputs: Vec<FilePair>, format: OutputFormat, all: bool, jobs: usize) -> String {
    let mut out = Vec::new();
    report(
        &DiffEngine::new(jobs).unwrap(),
        inputs.into_iter().map(Ok),
        format,
        "nothing changed",
        ReportOptions { all },
        &mut out,
        &mut Vec::new(),
    )
    .unwrap();
    String::from_utf8(out).unwrap()
}

#[test]
fn config_reads_nearest_defaults_prioritizes_toml_and_preserves_legacy_syntax() {
    let root = tempdir().unwrap();
    assert_eq!(load_config(root.path()).format, None);
    fs::write(
        root.path().join(".differensrc.json"),
        r#"{"format":"json","driverExtensions":["ts","py"]}"#,
    )
    .unwrap();
    let config = load_config(root.path());
    assert_eq!(config.format, Some(OutputFormat::Json));
    assert_eq!(config.driver_extensions.unwrap(), ["ts", "py"]);
    fs::write(
        root.path().join("differens.toml"),
        "# comment\nformat = 'markdown'\ndriverExtensions = [\"go\", \"rs\"]\n",
    )
    .unwrap();
    let deep = root.path().join("a/b/c");
    fs::create_dir_all(&deep).unwrap();
    assert_eq!(load_config(&deep).format, Some(OutputFormat::Markdown));
    fs::write(
        root.path().join("differens.toml"),
        "ai = true\nnot a valid line\nformat = json\n",
    )
    .unwrap();
    assert_eq!(load_config(&deep).format, Some(OutputFormat::Json));
    fs::write(
        root.path().join("differens.toml"),
        "format = 'excel'\ndriverExtensions = 'ts'\n",
    )
    .unwrap();
    assert_eq!(load_config(&deep).format, None);
    assert_eq!(load_config(&deep).driver_extensions, None);
}

#[test]
fn empty_machine_outputs_remain_valid_and_human_message_is_preserved() {
    let json = rendered(vec![], OutputFormat::Json, false, 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&json).unwrap(),
        serde_json::json!({"perFile":[],"crossFileMoves":[]})
    );
    assert_eq!(rendered(vec![], OutputFormat::Ndjson, false, 1), "");
    assert_eq!(
        rendered(vec![], OutputFormat::Terminal, false, 1),
        "nothing changed\n"
    );
    assert!(rendered(vec![], OutputFormat::Llm, false, 1).starts_with("differens/1"));
}

#[test]
fn ordered_windows_produce_identical_reports_with_one_or_four_threads() {
    let inputs: Vec<_> = (0..50)
        .map(|index| pair(&format!("a{index}.ts"), "const x = 1;", "const x = 2;"))
        .collect();
    let serial = rendered(inputs.clone(), OutputFormat::Json, false, 1);
    assert_eq!(serial, rendered(inputs, OutputFormat::Json, false, 4));
    let value: serde_json::Value = serde_json::from_str(&serial).unwrap();
    assert_eq!(value["perFile"].as_array().unwrap().len(), 50);
    assert_eq!(value["perFile"][49]["filePath"], "a49.ts");
}

#[test]
fn standalone_json_is_array_ndjson_has_one_record_and_renames_are_semantic() {
    let mut input = pair(
        "old.ts",
        "function oldName() { return 1; }",
        "function newName() { return 1; }",
    );
    input.new_path = "new.ts".into();
    let mut out = Vec::new();
    report_file(&input, OutputFormat::Json, &mut out, &mut Vec::new()).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(json.is_array());
    assert!(json.as_array().unwrap().iter().any(|change| {
        change["description"]
            .as_str()
            .unwrap()
            .contains("renamed function")
    }));
    assert!(!String::from_utf8_lossy(&out).contains("renamed file"));
    out.clear();
    report_file(&input, OutputFormat::Ndjson, &mut out, &mut Vec::new()).unwrap();
    assert_eq!(String::from_utf8_lossy(&out).lines().count(), 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out).unwrap()["filePath"],
        "old.ts"
    );
}

#[test]
fn cross_file_moves_appear_once_and_keep_original_raw_json_edits() {
    let moved = "function validate(input: string): boolean { return !!input; }\n";
    let inputs = vec![
        pair(
            "utils.ts",
            &format!("{moved}export const keep = 1;\n"),
            "export const keep = 1;\n",
        ),
        pair(
            "validators.ts",
            "export const v = 1;\n",
            &format!("export const v = 1;\n{moved}"),
        ),
    ];
    let terminal = rendered(inputs.clone(), OutputFormat::Terminal, false, 2);
    assert!(terminal.contains("cross-file moves:"), "{terminal}");
    assert!(!terminal.contains("no logical changes"), "{terminal}");
    assert!(
        !terminal.contains("added function `validate`"),
        "{terminal}"
    );
    let json: serde_json::Value =
        serde_json::from_str(&rendered(inputs.clone(), OutputFormat::Json, false, 2)).unwrap();
    assert_eq!(json["crossFileMoves"].as_array().unwrap().len(), 1);
    assert_eq!(json["crossFileMoves"][0]["fromFile"], "utils.ts");
    assert_ne!(
        json["perFile"].as_array().unwrap().as_slice(),
        &[] as &[serde_json::Value]
    );
    let llm = rendered(inputs, OutputFormat::Llm, false, 1);
    assert_eq!(
        llm.lines().next(),
        Some("differens/1 2 files 1 changes 1 named")
    );
    assert!(
        llm.contains("# cross-file\n> validate utils.ts -> validators.ts"),
        "{llm}"
    );
}

#[test]
fn llm_move_context_does_not_double_count_files_with_other_edits() {
    let moved = "function validate(input: string): boolean { return !!input; }\n";
    let inputs = vec![
        pair(
            "utils.ts",
            &format!("{moved}export const keep = 1;\n"),
            "export const keep = 2;\n",
        ),
        pair(
            "validators.ts",
            "export const v = 1;\n",
            &format!("export const v = 1;\n{moved}"),
        ),
    ];
    let llm = rendered(inputs, OutputFormat::Llm, false, 1);
    assert_eq!(
        llm.lines().next(),
        Some("differens/1 2 files 2 changes 2 named"),
        "{llm}"
    );
    assert!(llm.contains("# cross-file\n> validate utils.ts -> validators.ts"));
}

#[test]
fn llm_groups_go_methods_with_receiver_identity_before_detaching_nodes() {
    let old = "package main\n\
type A struct {}\n\
type B struct {}\n\
func (a A) Flush() int { return 1 }\n\
func (b B) Flush() int { return 2 }\n";
    let new = old
        .replace("return 1", "return 3")
        .replace("return 2", "return 4");
    let llm = rendered(
        vec![pair("flush.go", old, &new)],
        OutputFormat::Llm,
        false,
        1,
    );
    assert!(llm.contains("A.Flush"), "{llm}");
    assert!(llm.contains("B.Flush"), "{llm}");
    assert!(
        llm.lines()
            .next()
            .unwrap()
            .starts_with("differens/1 1 files 2 changes "),
        "{llm}"
    );

    let grouped = rendered(
        vec![pair(
            "one.ts",
            "function run() { return 1 + 2; }",
            "function run() { return 3 + 4; }",
        )],
        OutputFormat::Llm,
        false,
        1,
    );
    assert_eq!(
        grouped.lines().next(),
        Some("differens/1 1 files 2 changes 1 named"),
        "{grouped}"
    );
}

#[test]
fn shared_flush_helper_addition_keeps_every_existing_receiver_edit_visible() {
    let receivers = [
        "flushWriter",
        "flushHijackWriter",
        "httpFancyWriter",
        "http2FancyWriter",
    ];
    let prefix = "package middleware\nimport \"net/http\"\n\
type basicWriter struct { http.ResponseWriter; wroteHeader bool; discard bool }\n\
func (b *basicWriter) maybeWriteHeader() { b.wroteHeader = true }\n";
    let mut old = prefix.to_owned();
    for receiver in receivers {
        old.push_str(&format!(
            "type {receiver} struct {{ basicWriter }}\n\
func (f *{receiver}) Flush() {{\n\
f.wroteHeader = true\n\
fl := f.basicWriter.ResponseWriter.(http.Flusher)\n\
fl.Flush()\n\
}}\n"
        ));
    }
    let helper = "func (b *basicWriter) flush() {\n\
b.maybeWriteHeader()\n\
if !b.discard { b.ResponseWriter.(http.Flusher).Flush() }\n\
}\n";
    let mut new = format!("{prefix}{helper}");
    for receiver in receivers {
        new.push_str(&format!(
            "type {receiver} struct {{ basicWriter }}\n\
func (f *{receiver}) Flush() {{ f.basicWriter.flush() }}\n"
        ));
    }
    let input = pair("wrap_writer.go", &old, &new);
    let raw = diff_inline(&input).unwrap();
    assert!(
        !raw.changes.iter().any(|change| {
            matches!(change.action, differens_core::EditAction::Update { .. })
                && change.action.context().iter().any(|context| {
                    context.kind == "Method" && context.label.as_deref() == Some("flush")
                })
        }),
        "new helper must be an addition without descendant modifications"
    );
    assert_eq!(
        raw.changes
            .iter()
            .filter(|change| {
                matches!(change.action, differens_core::EditAction::Insert { .. })
                    && change.action.node().kind == "Method"
                    && change.action.node().label.as_deref() == Some("flush")
            })
            .count(),
        1
    );
    let raw_count = raw.changes.len();
    let llm = rendered(vec![input], OutputFormat::Llm, false, 1);
    assert!(
        llm.lines()
            .next()
            .unwrap()
            .starts_with(&format!("differens/1 1 files {raw_count} changes ")),
        "{llm}"
    );
    for receiver in receivers {
        assert!(llm.contains(&format!("{receiver}.Flush")), "{llm}");
    }
    assert!(llm.contains("+ method basicWriter.flush"), "{llm}");
    assert!(!llm.contains("modified method basicWriter.flush"), "{llm}");
}

#[test]
fn large_reports_use_bounded_overview_and_all_restores_every_file() {
    let inputs: Vec<_> = (0..1000)
        .map(|index| {
            pair(
                &format!("services/backend/src/billing/file{index}.ts"),
                "",
                &format!("export const value{index} = {index};"),
            )
        })
        .collect();
    let overview = rendered(inputs.clone(), OutputFormat::Terminal, false, 4);
    assert!(
        overview.contains("1000 files with logical changes: 1000 added"),
        "{overview}"
    );
    assert!(
        overview.contains("services/backend/src/billing/"),
        "{overview}"
    );
    assert!(overview.lines().count() < 15, "{overview}");
    let all = rendered(inputs, OutputFormat::Terminal, true, 4);
    assert!(all.contains("file999.ts"));
    assert!(!all.contains("Selected changes"));
}

#[test]
fn empty_existing_file_rename_keeps_file_identity() {
    let mut input = pair("old.ts", "", "");
    input.old_exists = true;
    input.new_exists = true;
    input.new_path = "new.ts".into();
    let result = diff_inline(&input).unwrap();
    assert_eq!(result.changes.len(), 1);
    assert_eq!(
        result.changes[0].description,
        "renamed file `old.ts` to `new.ts`"
    );
}

#[test]
fn input_errors_do_not_drop_preceding_results() {
    let engine = DiffEngine::new(2).unwrap();
    let inputs = vec![
        Ok(pair("a.txt", "old", "new")),
        Err(differens_git::Error::Process(io::Error::other(
            "failed input",
        ))),
    ];
    let mut stream = engine.stream(inputs);
    assert_eq!(stream.next().unwrap().unwrap().file_path, "a.txt");
    assert!(stream.next().unwrap().is_err());
    assert!(stream.next().is_none());
}
