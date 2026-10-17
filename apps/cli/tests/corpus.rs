use std::{collections::BTreeSet, fs, path::Path, process::Command};

use tempfile::tempdir;

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn build_repo(root: &Path) {
    for index in 0..=80 {
        let body = if index == 80 {
            "export const keep80 = 80;\n".into()
        } else {
            format!(
                "export function fn{index}(x: number): number {{ return x + {index}; }}\nexport const keep{index} = {index};\n"
            )
        };
        write(root, &format!("src/f{index}.ts"), &body);
    }
    for index in 0..30 {
        write(root, &format!("config/c{index}.json"), &serde_json::to_string_pretty(&serde_json::json!({"name":format!("svc{index}"),"port":3000+index,"host":"localhost"})).unwrap());
    }
    for index in 0..20 {
        write(
            root,
            &format!("docs/d{index}.md"),
            &format!("# Doc {index}\n\nStatic line one.\nStatic line two.\n"),
        );
    }
    for index in 0..10 {
        write(
            root,
            &format!("notes/n{index}.txt"),
            &format!("note {index} body text.\n"),
        );
        write(
            root,
            &format!("py/p{index}.py"),
            &format!("def py_fn_{index}(x):\n    return x + {index}\n"),
        );
    }
}

#[test]
fn mixed_tier_corpus_pins_exact_changed_paths_and_two_cross_file_moves() {
    let old = tempdir().unwrap();
    let new = tempdir().unwrap();
    build_repo(old.path());
    build_repo(new.path());
    let mut expected = BTreeSet::new();
    for index in 0..5 {
        let path = format!("src/f{index}.ts");
        write(
            new.path(),
            &path,
            &format!(
                "export function renamed{index}(x: number): number {{ return x + {index}; }}\nexport const keep{index} = {index};\n"
            ),
        );
        expected.insert(path);
        let path = format!("docs/d{index}.md");
        write(
            new.path(),
            &path,
            &format!("# Doc {index}\n\nEdited line one.\nStatic line two.\n"),
        );
        expected.insert(path);
        let path = format!("notes/n{index}.txt");
        write(
            new.path(),
            &path,
            &format!("note {index} body edited text.\n"),
        );
        expected.insert(path);
    }
    for index in 0..10 {
        let path = format!("config/c{index}.json");
        write(new.path(), &path, &serde_json::to_string_pretty(&serde_json::json!({"name":format!("svc{index}"),"port":4000+index,"host":"localhost"})).unwrap());
        expected.insert(path);
    }
    for path in ["src/f70.ts", "config/c20.json", "docs/d10.md"] {
        fs::remove_file(new.path().join(path)).unwrap();
        expected.insert(path.into());
    }
    for index in 0..3 {
        let path = format!("src/added{index}.ts");
        write(
            new.path(),
            &path,
            &format!("export function added{index}(): number {{ return {index}; }}\n"),
        );
        expected.insert(path);
    }
    write(new.path(), "src/f79.ts", "export const keep79 = 79;\n");
    write(new.path(), "src/f78.ts", "export const keep78 = 78;\n");
    write(
        new.path(),
        "src/f80.ts",
        "export function fn79(x: number): number { return x + 79; }\nexport function fn78(x: number): number { return x + 780; }\nexport const keep80 = 80;\n",
    );
    expected.extend([
        "src/f78.ts".into(),
        "src/f79.ts".into(),
        "src/f80.ts".into(),
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_differens"))
        .args([
            old.path().as_os_str(),
            new.path().as_os_str(),
            std::ffi::OsStr::new("--format=ndjson"),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let records: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let actual: BTreeSet<_> = records
        .iter()
        .filter_map(|record| record["filePath"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(actual, expected);
    let moves = records
        .iter()
        .find_map(|record| record["crossFileMoves"].as_array())
        .unwrap();
    assert_eq!(moves.len(), 2, "{moves:?}");
    let exact = moves
        .iter()
        .find(|movement| movement["name"] == "fn79")
        .unwrap();
    assert_eq!(exact["modified"], false);
    let edited = moves
        .iter()
        .find(|movement| movement["name"] == "fn78")
        .unwrap();
    assert_eq!(edited["modified"], true);
    assert_eq!(edited["fromFile"], "src/f78.ts");
    assert_eq!(edited["toFile"], "src/f80.ts");
}
