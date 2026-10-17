use std::{
    fs,
    io::{self, Write},
};

use differens_engine::{
    DiffEngine, ReportOptions, diff_inline, load_config, overview, report, report_file,
};
use differens_git::FilePair;
use differens_narrate::OutputFormat;

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

fn render(inputs: Vec<FilePair>, format: OutputFormat) -> (String, String) {
    let mut out = Vec::new();
    let mut diagnostics = Vec::new();
    report(
        &DiffEngine::new(2).unwrap(),
        inputs.into_iter().map(Ok),
        format,
        "empty",
        ReportOptions::default(),
        &mut out,
        &mut diagnostics,
    )
    .unwrap();
    (
        String::from_utf8(out).unwrap(),
        String::from_utf8(diagnostics).unwrap(),
    )
}

#[test]
fn fallback_metadata_and_diagnostics_are_preserved_in_all_report_modes() {
    let input = pair("bad.json", "{ broken old", "{ broken new");
    let result = diff_inline(&input).unwrap();
    assert!(result.fallback.is_some());
    for format in [OutputFormat::Terminal, OutputFormat::Markdown] {
        let (output, diagnostics) = render(vec![input.clone()], format);
        assert!(output.contains("modified") || output.contains("changed"));
        assert!(
            diagnostics.contains("1 file used line-diff fallback: bad.json"),
            "{diagnostics}"
        );
    }
    let (json, _) = render(vec![input.clone()], OutputFormat::Json);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&json).unwrap()["fallbacks"][0]["filePath"],
        "bad.json"
    );
    let (ndjson, _) = render(vec![input.clone()], OutputFormat::Ndjson);
    assert!(serde_json::from_str::<serde_json::Value>(&ndjson).unwrap()["fallback"].is_string());
    let inputs = (0..6)
        .map(|index| pair(&format!("bad{index}.json"), "{ old", "{ new"))
        .collect();
    assert!(render(inputs, OutputFormat::Terminal).1.contains(", …"));
    let mut out = Vec::new();
    let mut diagnostics = Vec::new();
    report_file(&input, OutputFormat::Terminal, &mut out, &mut diagnostics).unwrap();
    assert!(
        String::from_utf8(diagnostics)
            .unwrap()
            .contains("fell back to")
    );
}

#[test]
fn wide_mixed_changesets_keep_exact_area_totals_and_bound_examples() {
    let mut changes = Vec::new();
    for index in 0..1000 {
        let path = format!("area{}/sub{}/file{index}.ts", index % 100, index % 20);
        let input = match index % 4 {
            0 => pair(&path, "", "function added(){return true}"),
            1 => pair(&path, "function gone(){return true}", ""),
            2 => pair(
                &path,
                "function changed(){return 1}",
                "function changed(){return 2}",
            ),
            _ => {
                let mut input = pair(
                    &path,
                    "function same(){return 1}",
                    "function same(){return 1}",
                );
                input.old_path = format!("previous/{path}");
                input
            }
        };
        changes.extend(diff_inline(&input).unwrap().changes);
    }
    let output = overview(&changes, &[], OutputFormat::Markdown).unwrap();
    assert!(
        output.contains("250 added, 250 removed, 250 modified, 250 renamed"),
        "{output}"
    );
    assert!(output.lines().count() < 70);
    let area_total: usize = output
        .lines()
        .filter_map(|line| line.split_once(" — "))
        .map(|(_, counts)| {
            counts
                .split(", ")
                .map(|count| count.split_once(' ').unwrap().0.parse::<usize>().unwrap())
                .sum::<usize>()
        })
        .sum();
    assert_eq!(area_total, 1000);
}

#[test]
fn overview_includes_large_move_sets_and_truncates_long_facts() {
    use differens_core::{NodeSpec, TreeBuilder};
    use differens_correlate::{ActionId, CrossFileMatch};
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new("file");
    spec.label = Some("moved".into());
    let root = builder.push(spec).unwrap();
    let node = builder.finish(root).unwrap().root_ref();
    let moves: Vec<_> = (0..21)
        .map(|index| CrossFileMatch {
            node: node.clone(),
            from_file: format!("old/{index}.ts"),
            to_file: format!("new/{index}.ts"),
            modified: index % 2 == 0,
            similarity: 1.0,
            deletion: ActionId {
                file: index,
                action: 0,
            },
            insertion: ActionId {
                file: index + 21,
                action: 0,
            },
        })
        .collect();
    let output = overview(&[], &moves, OutputFormat::Terminal).unwrap();
    assert!(output.contains("21 renamed"), "{output}");
    assert!(output.contains("21 cross-file moves; examples:"));
    assert!(output.contains("also edited"));
    let mut changes = Vec::new();
    for index in 0..21 {
        let mut change = diff_inline(&pair(&format!("root{index}.ts"), "", "const x = 1;"))
            .unwrap()
            .changes
            .remove(0);
        change.description = format!("added file {}", "界".repeat(200));
        changes.push(change);
    }
    let output = overview(&changes, &[], OutputFormat::Terminal).unwrap();
    assert!(output.contains('…'));
    assert!(output.contains("(root)"));
}

#[test]
fn malformed_config_skips_to_alternate_file_and_handles_unquoted_legacy_values() {
    let root = tempfile::tempdir().unwrap();
    let child = root.path().join("child");
    fs::create_dir(&child).unwrap();
    fs::write(root.path().join("differens.toml"), "format = 'llm'").unwrap();
    fs::write(child.join("differens.toml"), "format = \"unclosed\n").unwrap();
    fs::write(child.join(".differensrc.json"), "not json").unwrap();
    assert_eq!(load_config(&child).format, Some(OutputFormat::Llm));
    fs::write(child.join("differens.toml"), "# comment\n\nunknown = no\nformat = markdown\ndriverExtensions = [\"ts\", \"py\"]\nignored malformed line\n").unwrap();
    let config = load_config(&child);
    assert_eq!(config.format, Some(OutputFormat::Markdown));
    assert_eq!(config.driver_extensions.unwrap(), ["ts", "py"]);
    fs::write(
        child.join("differens.toml"),
        "format =\ndriverExtensions = [broken\n",
    )
    .unwrap();
    fs::write(
        child.join(".differensrc.json"),
        r#"{"format":"json","driverExtensions":["ts",7]}"#,
    )
    .unwrap();
    let config = load_config(&child);
    assert_eq!(config.format, Some(OutputFormat::Json));
    assert_eq!(config.driver_extensions, None);
}

struct BrokenWriter;
impl Write for BrokenWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed output"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed output"))
    }
}

#[test]
fn writer_failures_propagate_without_silent_success() {
    let input = pair("a.ts", "const x=1", "const x=2");
    for format in [
        OutputFormat::Json,
        OutputFormat::Ndjson,
        OutputFormat::Terminal,
    ] {
        assert!(
            report(
                &DiffEngine::new(1).unwrap(),
                vec![Ok(input.clone())],
                format,
                "empty",
                ReportOptions::default(),
                &mut BrokenWriter,
                &mut Vec::new()
            )
            .is_err()
        );
        assert!(report_file(&input, format, &mut BrokenWriter, &mut Vec::new()).is_err());
    }
}
