use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

use tempfile::{TempDir, tempdir};

struct Repo {
    dir: TempDir,
}
impl Repo {
    fn new() -> Self {
        let fixture = Self {
            dir: tempdir().unwrap(),
        };
        fixture.git(&["init", "-q"]);
        fixture.git(&["config", "user.name", "Test"]);
        fixture.git(&["config", "user.email", "test@example.com"]);
        fixture
    }
    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(self.dir.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn write(&self, path: &str, content: &[u8]) {
        let path = self.dir.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn commit(&self) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", "test", "--allow-empty"]);
    }
    fn cli(&self, args: &[&str]) -> Output {
        cli(self.dir.path(), args)
    }
}

fn cli(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_differens"))
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap()
}
fn stdout(output: &Output) -> String {
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn working_tree_reports_clean_modified_added_and_deleted_files() {
    let fixture = Repo::new();
    fixture.write("a.ts", b"export const a = 1;\n");
    fixture.commit();
    assert!(stdout(&fixture.cli(&[])).contains("nothing changed"));
    fixture.write("a.ts", b"export const a = 2;\n");
    assert!(stdout(&fixture.cli(&["diff"])).contains("1 modification"));
    fixture.write("b.ts", b"export const b = 2;\n");
    assert!(stdout(&fixture.cli(&[])).contains("added file `b.ts`"));
    fs::remove_file(fixture.dir.path().join("a.ts")).unwrap();
    assert!(stdout(&fixture.cli(&[])).contains("removed file `a.ts`"));
}

#[test]
fn standalone_files_detect_renames_and_support_all_formats() {
    let fixture = Repo::new();
    fixture.write(
        "old.ts",
        b"export function parseConfig(raw: string) { return raw; }\n",
    );
    fixture.write(
        "new.ts",
        b"export function loadConfig(raw: string) { return raw; }\n",
    );
    let terminal = stdout(&fixture.cli(&["old.ts", "new.ts"]));
    assert!(terminal.contains("renamed"));
    assert!(terminal.contains("loadConfig"));
    for flag in ["--format=json", "--json", "-j"] {
        let json: serde_json::Value =
            serde_json::from_str(&stdout(&fixture.cli(&["old.ts", "new.ts", flag]))).unwrap();
        assert!(json.is_array());
    }
    for flag in ["--format=markdown", "--markdown", "--md"] {
        assert!(stdout(&fixture.cli(&["old.ts", "new.ts", flag])).contains("## old.ts"));
    }
    for flag in ["--format=llm", "--llm", "-l"] {
        assert!(stdout(&fixture.cli(&["old.ts", "new.ts", flag])).starts_with("differens/1"));
    }
    let ndjson = stdout(&fixture.cli(&["old.ts", "new.ts", "--format", "ndjson"]));
    for line in ndjson.lines() {
        assert!(serde_json::from_str::<serde_json::Value>(line).is_ok());
    }
}

#[test]
fn directories_compare_relative_paths_and_reject_mixed_inputs() {
    let fixture = Repo::new();
    fixture.write("old/a.ts", b"const a = 1;");
    fixture.write("new/a.ts", b"const a = 2;");
    assert!(stdout(&fixture.cli(&["old", "new"])).contains("changed"));
    let output = fixture.cli(&["old", "new/a.ts"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("cannot diff a directory against a file")
    );
    let output = fixture.cli(&["missing-old", "missing-new"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot read file"));
}

#[test]
fn ranges_two_refs_and_empty_machine_outputs_work() {
    let fixture = Repo::new();
    fixture.write("a.ts", b"export const a = 1;");
    fixture.commit();
    fixture.write("a.ts", b"export const a = 2;");
    fixture.commit();
    for args in [
        vec!["HEAD~1", "HEAD"],
        vec!["HEAD~1..HEAD"],
        vec!["diff", "HEAD~1..HEAD"],
    ] {
        assert!(stdout(&fixture.cli(&args)).contains("1 modification"));
    }
    let json: serde_json::Value =
        serde_json::from_str(&stdout(&fixture.cli(&["HEAD~1..HEAD", "--format=json"]))).unwrap();
    assert!(json["perFile"].is_array());
    assert!(json["crossFileMoves"].is_array());
    assert!(stdout(&fixture.cli(&["HEAD..HEAD"])).contains("nothing changed"));
    assert!(
        serde_json::from_str::<serde_json::Value>(&stdout(&fixture.cli(&["HEAD..HEAD", "--json"])))
            .is_ok()
    );
    assert_eq!(stdout(&fixture.cli(&["HEAD..HEAD", "--format=ndjson"])), "");
    assert!(!fixture.cli(&["HEAD...HEAD"]).status.success());
    assert!(!fixture.cli(&["nope..HEAD"]).status.success());
    assert!(!fixture.cli(&["not-a-range"]).status.success());
}

#[test]
fn cross_file_moves_survive_terminal_json_and_streaming_modes() {
    let fixture = Repo::new();
    let moved = "function validate(input: string): boolean { return !!input; }\n";
    fixture.write(
        "utils.ts",
        format!("{moved}export const keep = 1;\n").as_bytes(),
    );
    fixture.write("validators.ts", b"export const v = 1;\n");
    fixture.commit();
    fixture.write("utils.ts", b"export const keep = 1;\n");
    fixture.write(
        "validators.ts",
        format!("export const v = 1;\n{moved}").as_bytes(),
    );
    fixture.commit();
    let output = stdout(&fixture.cli(&["HEAD~1..HEAD"]));
    assert!(output.contains("cross-file moves"));
    assert!(output.contains("validate"));
    let output = stdout(&fixture.cli(&["HEAD~1..HEAD", "--format=ndjson"]));
    let records: Vec<serde_json::Value> = output
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        records.last().unwrap()["crossFileMoves"][0]["name"],
        "validate"
    );
}

#[test]
fn config_defaults_and_flags_override_as_expected() {
    let fixture = Repo::new();
    fixture.write(".differensrc.json", br#"{"format":"json"}"#);
    fixture.write("old.ts", b"const a = 1;");
    fixture.write("new.ts", b"const a = 2;");
    assert!(
        serde_json::from_str::<serde_json::Value>(&stdout(&fixture.cli(&["old.ts", "new.ts"])))
            .unwrap()
            .is_array()
    );
    assert!(stdout(&fixture.cli(&["old.ts", "new.ts", "--format=llm"])).starts_with("differens/1"));
    fixture.write("differens.toml", b"format = 'markdown'\n");
    assert!(stdout(&fixture.cli(&["old.ts", "new.ts"])).contains("## old.ts"));
}

#[test]
fn commands_help_version_languages_and_validation_work_without_repository() {
    let directory = tempdir().unwrap();
    let help = stdout(&cli(directory.path(), &["--help"]));
    assert!(help.contains("--format"));
    assert!(help.contains("--all"));
    for flag in ["--version", "-v"] {
        assert_eq!(
            stdout(&cli(directory.path(), &[flag])).trim(),
            format!("differens v{}", env!("CARGO_PKG_VERSION"))
        );
    }
    let languages = stdout(&cli(directory.path(), &["languages"]));
    assert!(languages.contains("typescript"));
    assert!(languages.contains("rust"));
    assert!(languages.contains("binary files"));
    for args in [
        &[][..],
        &["--format=invalid"][..],
        &["--unknown"][..],
        &["--jobs=-1"][..],
        &["install-git-driver"][..],
    ] {
        assert!(!cli(directory.path(), args).status.success(), "{args:?}");
    }
}

#[test]
fn git_driver_uses_display_path_and_supports_added_empty_file_presence() {
    let fixture = Repo::new();
    fixture.write(
        "blob_a",
        b"export function parse(raw: string) { return JSON.parse(raw); }\n",
    );
    fixture.write(
        "blob_b",
        b"export function parse( raw: string ) {\n return JSON.parse(raw);\n}\n",
    );
    let output = stdout(&fixture.cli(&[
        "--git-diff-driver",
        "sample.ts",
        "blob_a",
        "0000",
        "100644",
        "blob_b",
        "0000",
        "100644",
    ]));
    assert_eq!(output.trim(), "no logical changes");
    fixture.write("blob_b", b"");
    let output = stdout(&fixture.cli(&[
        "--git-diff-driver",
        "empty.ts",
        "/dev/null",
        "0000",
        "000000",
        "blob_b",
        "0000",
        "100644",
    ]));
    assert!(output.contains("added file `empty.ts`"), "{output}");
    assert!(
        !fixture
            .cli(&["--git-diff-driver", "only-path"])
            .status
            .success()
    );
}

#[test]
fn installed_driver_runs_via_git_and_is_idempotent() {
    let fixture = Repo::new();
    fixture.write("differens.toml", b"driverExtensions = ['ts']\n");
    fixture.write("a.ts", b"export function oldName() { return 1; }");
    fixture.commit();
    let output = stdout(&fixture.cli(&["install-git-driver"]));
    assert!(output.contains("git diff driver installed"));
    let attributes = fs::read(fixture.dir.path().join(".gitattributes")).unwrap();
    stdout(&fixture.cli(&["install-git-driver"]));
    assert_eq!(
        fs::read(fixture.dir.path().join(".gitattributes")).unwrap(),
        attributes
    );
    fixture.write("a.ts", b"export function newName() { return 1; }");
    let output = fixture.git(&["diff", "--", "a.ts"]);
    assert!(output.contains("renamed"), "{output}");
    assert!(output.contains("newName"));
    // Our own Git reading bypasses the configured driver, preventing recursion.
    assert!(stdout(&fixture.cli(&["--json"])).contains("perFile"));
}

#[test]
fn binary_invalid_utf8_changes_are_not_lost() {
    let fixture = Repo::new();
    fixture.write("old.bin", b"\0\xff\x01");
    fixture.write("new.bin", b"\0\xfe\x01");
    let json: serde_json::Value =
        serde_json::from_str(&stdout(&fixture.cli(&["old.bin", "new.bin", "--json"]))).unwrap();
    assert_ne!(
        json.as_array().unwrap().as_slice(),
        &[] as &[serde_json::Value]
    );
}

#[test]
fn directory_inputs_detect_whole_file_rename_with_and_without_edits() {
    let fixture = Repo::new();
    fixture.write(
        "old/src/helpers.ts",
        b"export function helper(x: number): number { return x * 2; }\n",
    );
    fixture.write(
        "new/lib/util.ts",
        b"export function helper(x: number): number { return x * 2; }\n",
    );
    let output = stdout(&fixture.cli(&["old", "new"]));
    assert!(
        output.contains("renamed file src/helpers.ts to lib/util.ts"),
        "{output}"
    );
    fixture.write(
        "new/lib/util.ts",
        b"export function helper(x: number): number { return x * 3; }\n",
    );
    let output = stdout(&fixture.cli(&["old", "new"]));
    assert!(output.contains("renamed and edited file"), "{output}");
}

#[test]
fn nested_working_directory_uses_repository_paths_and_ancestor_config() {
    let fixture = Repo::new();
    fixture.write("a.ts", b"export const a = 1;\n");
    fixture.write("differens.toml", b"format = 'llm'\n");
    fixture.commit();
    fixture.write("a.ts", b"export const a = 2;\n");
    fs::create_dir(fixture.dir.path().join("sub")).unwrap();
    let output = stdout(&cli(&fixture.dir.path().join("sub"), &[]));
    assert!(output.contains("# a.ts"), "{output}");
}

#[cfg(unix)]
#[test]
fn explicit_file_paths_skip_git_processes_but_ambiguous_names_still_probe() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Repo::new();
    fixture.write("old.ts", b"function oldName(){return 1}");
    fixture.write("new.ts", b"function newName(){return 1}");
    fixture.write(
        "bin/git",
        b"#!/bin/sh\nprintf called >> \"$DIFFERENS_GIT_MARKER\"\nexit 1\n",
    );
    fs::set_permissions(
        fixture.dir.path().join("bin/git"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let marker = fixture.dir.path().join("git-called");
    let invoke = |old: &Path, new: &Path| {
        Command::new(env!("CARGO_BIN_EXE_differens"))
            .current_dir(fixture.dir.path())
            .args([old, new])
            .env("PATH", fixture.dir.path().join("bin"))
            .env("DIFFERENS_GIT_MARKER", &marker)
            .output()
            .unwrap()
    };
    assert!(
        stdout(&invoke(
            &fixture.dir.path().join("old.ts"),
            &fixture.dir.path().join("new.ts")
        ))
        .contains("renamed")
    );
    assert!(stdout(&invoke(Path::new("./old.ts"), Path::new("./new.ts"))).contains("renamed"));
    assert!(!marker.exists());
    assert!(stdout(&invoke(Path::new("old.ts"), Path::new("new.ts"))).contains("renamed"));
    assert!(marker.exists());
}

#[test]
fn ambiguous_relative_names_keep_commit_precedence_over_existing_files() {
    let fixture = Repo::new();
    fixture.write("source.ts", b"const x = 1;");
    fixture.commit();
    fixture.git(&["branch", "old.ts"]);
    fixture.write("source.ts", b"const x = 2;");
    fixture.commit();
    fixture.git(&["branch", "new.ts"]);
    fixture.write("old.ts", b"const irrelevant = true;");
    fixture.write("new.ts", b"const irrelevant = false;");
    let json: serde_json::Value =
        serde_json::from_str(&stdout(&fixture.cli(&["old.ts", "new.ts", "--json"]))).unwrap();
    assert!(json["perFile"].is_array());
    assert_eq!(json["perFile"][0]["filePath"], "source.ts");
    let json: serde_json::Value =
        serde_json::from_str(&stdout(&fixture.cli(&["./old.ts", "./new.ts", "--json"]))).unwrap();
    assert!(json.is_array());
}

#[test]
fn closed_stdout_exits_cleanly_for_single_file_and_streamed_machine_outputs() {
    use std::process::Stdio;
    let fixture = Repo::new();
    let old = (0..300)
        .map(|index| format!("old-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let new = (0..300)
        .map(|index| format!("new-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    fixture.write("old/a.md", old.as_bytes());
    fixture.write("new/a.md", new.as_bytes());
    for arguments in [
        vec!["./old/a.md", "./new/a.md", "--json"],
        vec!["old", "new", "--format=ndjson"],
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_differens"))
            .current_dir(fixture.dir.path())
            .args(arguments)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(child.stdout.take());
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stderr, b"");
    }
}

#[cfg(unix)]
#[test]
fn malformed_driver_paths_and_unexpected_command_inputs_fail_clearly() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let fixture = Repo::new();
    let arguments = [
        OsString::from("--git-diff-driver"),
        OsString::from_vec(b"bad-\xff.ts".to_vec()),
        OsString::from("/dev/null"),
        OsString::from("0"),
        OsString::from("000000"),
        OsString::from("/dev/null"),
        OsString::from("0"),
        OsString::from("000000"),
    ];
    let output = Command::new(env!("CARGO_BIN_EXE_differens"))
        .current_dir(fixture.dir.path())
        .args(arguments)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("UTF-8"));
    for arguments in [
        &["languages", "extra"][..],
        &["install-git-driver", "extra"][..],
        &["diff", "one", "two", "three"][..],
    ] {
        assert!(!fixture.cli(arguments).status.success());
    }
}

#[test]
fn separator_preserves_reserved_command_names_as_literal_file_inputs() {
    let fixture = Repo::new();
    for name in ["diff", "languages", "install-git-driver"] {
        fixture.write(name, b"old content");
    }
    fixture.write("new", b"new content");
    for name in ["diff", "languages", "install-git-driver"] {
        let json: serde_json::Value =
            serde_json::from_str(&stdout(&fixture.cli(&["--json", "--", name, "new"]))).unwrap();
        assert!(json.is_array());
    }
    for arguments in [
        &["--format", "json", "--", "diff", "new"][..],
        &["--json", "diff", "--", "diff", "new"][..],
        &["--jobs", "1", "--json", "--", "languages", "new"][..],
    ] {
        assert!(
            serde_json::from_str::<serde_json::Value>(&stdout(&fixture.cli(arguments)))
                .unwrap()
                .is_array()
        );
    }
}

#[test]
fn ndjson_keeps_tracked_changes_before_untracked_paths() {
    let fixture = Repo::new();
    fixture.write("z.ts", b"const z = 1;");
    fixture.commit();
    fixture.write("z.ts", b"const z = 2;");
    fixture.write("a.ts", b"const a = 1;");
    let output = stdout(&fixture.cli(&["--format=ndjson"]));
    let paths: Vec<_> = output
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["filePath"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(paths, ["z.ts", "a.ts"]);
}
