//! Repeatable audits of pinned public histories; no repository build scripts run.
use crate::{Result, command};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, process::Command, time::Instant};

#[derive(Deserialize)]
struct Repository {
    name: String,
    url: String,
    old: String,
    new: String,
    expected: Expectation,
}
#[derive(Deserialize)]
struct Expectation {
    file: String,
    kind: String,
    label: String,
}

fn git(repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git").args(args).current_dir(repo).output()?;
    if !output.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output.stdout)
}
fn prepare(repo: &Path, spec: &Repository, fetch: bool) -> Result<()> {
    if fetch {
        fs::create_dir_all(repo)?;
        if !repo.join(".git").exists() {
            git(repo, &["init", "-q"])?;
            git(repo, &["remote", "add", "origin", &spec.url])?;
        }
        git(
            repo,
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--depth=1",
                &spec.url,
                &spec.old,
                &spec.new,
            ],
        )?;
    }
    for revision in [&spec.old, &spec.new] {
        let resolved = git(
            repo,
            &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
        )?;
        if String::from_utf8(resolved)?.trim() != revision {
            return Err(format!("{}: unexpected revision {revision}", spec.name).into());
        }
    }
    Ok(())
}
fn invoke(
    binary: &Path,
    repo: &Path,
    spec: &Repository,
    format: &str,
    jobs: usize,
) -> Result<(Vec<u8>, f64)> {
    let start = Instant::now();
    let output = Command::new(binary)
        .args([&spec.old, &spec.new])
        .arg(format!("--format={format}"))
        .arg(format!("--jobs={jobs}"))
        .current_dir(repo)
        .output()?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    if !output.status.success() {
        return Err(format!(
            "{} {format}: {}",
            spec.name,
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok((output.stdout, elapsed))
}
fn file_paths(report: &Value) -> Result<BTreeSet<&str>> {
    report["perFile"]
        .as_array()
        .ok_or("missing perFile array")?
        .iter()
        .map(|change| {
            change["filePath"]
                .as_str()
                .ok_or_else(|| "missing change filePath".into())
        })
        .collect()
}
fn validate_report(spec: &Repository, changed: &BTreeSet<&str>, report: &Value) -> Result<()> {
    if &file_paths(report)? != changed {
        return Err(format!(
            "{}: semantic report omitted or invented changed files",
            spec.name
        )
        .into());
    }
    let expected = &spec.expected;
    let found = report["perFile"]
        .as_array()
        .ok_or("missing changes")?
        .iter()
        .any(|change| {
            change["filePath"] == expected.file
                && change["action"]["node"]["kind"] == expected.kind
                && change["action"]["node"]["label"] == expected.label
        });
    if !found {
        return Err(format!(
            "{}: lost expected {} {} in {}",
            spec.name, expected.kind, expected.label, expected.file
        )
        .into());
    }
    Ok(())
}
fn validate_ndjson(report: &Value, bytes: &[u8]) -> Result<()> {
    let mut changes = Vec::new();
    let mut moves = json!([]);
    let mut fallbacks = Vec::new();
    for line in bytes
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let mut record: Value = serde_json::from_slice(line)?;
        if let Some(file) = record["filePath"].as_str().map(str::to_owned) {
            if let Some(fallback) = record.get("fallback") {
                fallbacks.push(json!({"filePath":file,"fallback":fallback}));
            }
            let file_changes = record["changes"]
                .as_array_mut()
                .ok_or("missing NDJSON changes")?;
            for mut change in file_changes.drain(..) {
                change["filePath"] = json!(file);
                changes.push(change);
            }
        } else if let Some(value) = record.get("crossFileMoves") {
            moves = value.clone();
        } else {
            return Err("unknown NDJSON record".into());
        }
    }
    if report["perFile"] != json!(changes)
        || report["crossFileMoves"] != moves
        || report
            .get("fallbacks")
            .cloned()
            .unwrap_or_else(|| json!([]))
            != json!(fallbacks)
    {
        return Err("JSON and NDJSON contracts differ".into());
    }
    Ok(())
}
fn statistics(mut times: Vec<f64>) -> Value {
    times.sort_by(f64::total_cmp);
    let middle = times.len() / 2;
    let median = if times.len() % 2 == 0 {
        f64::midpoint(times[middle - 1], times[middle])
    } else {
        times[middle]
    };
    json!({"medianMs":median,"p95Ms":times[times.len()-times.len()/20-1],"allMs":times})
}
fn measure(
    binary: &Path,
    baseline: Option<&Path>,
    repo: &Path,
    spec: &Repository,
    expected: &Value,
    samples: usize,
) -> Result<Value> {
    let mut current = Vec::with_capacity(samples);
    let mut previous = Vec::with_capacity(samples);
    let mut baseline_report = None;
    for sample in 0..=samples {
        // Rotate process order so neither binary always benefits from running second.
        for before in if sample % 2 == 0 {
            [true, false]
        } else {
            [false, true]
        } {
            let executable = if before {
                if let Some(path) = baseline {
                    path
                } else {
                    continue;
                }
            } else {
                binary
            };
            let (bytes, time) = invoke(executable, repo, spec, "json", 0)?;
            let parsed: Value = serde_json::from_slice(&bytes)?;
            if !before && &parsed != expected {
                return Err(format!("{}: nondeterministic JSON", spec.name).into());
            }
            if before {
                baseline_report = Some(parsed);
            }
            if sample != 0 {
                if before {
                    previous.push(time);
                } else {
                    current.push(time);
                }
            }
        }
    }
    Ok(
        json!({"after":statistics(current),"before":(!previous.is_empty()).then(|| statistics(previous)),"baselineActions":baseline_report.map(|report| report["perFile"].as_array().map_or(0,Vec::len))}),
    )
}
fn audit(
    root: &Path,
    directory: &Path,
    binary: &Path,
    baseline: Option<&Path>,
    spec: &Repository,
    samples: usize,
    fetch: bool,
) -> Result<Value> {
    let repo = directory.join(&spec.name);
    prepare(&repo, spec, fetch)?;
    let paths = String::from_utf8(git(
        &repo,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            &spec.old,
            &spec.new,
        ],
    )?)?;
    let changed = paths.split('\0').filter(|path| !path.is_empty()).collect();
    let (bytes, _) = invoke(binary, &repo, spec, "json", 0)?;
    let report: Value = serde_json::from_slice(&bytes)?;
    validate_report(spec, &changed, &report)?;
    for jobs in [1, 4] {
        let (bytes, _) = invoke(binary, &repo, spec, "json", jobs)?;
        if serde_json::from_slice::<Value>(&bytes)? != report {
            return Err(format!("{}: job ordering differs", spec.name).into());
        }
    }
    validate_ndjson(&report, &invoke(binary, &repo, spec, "ndjson", 0)?.0)?;
    let output = root.join("target/audit-output");
    fs::create_dir_all(&output)?;
    for format in ["terminal", "markdown", "llm"] {
        let (bytes, _) = invoke(binary, &repo, spec, format, 0)?;
        if bytes.is_empty() {
            return Err(format!("{}: empty {format}", spec.name).into());
        }
        fs::write(output.join(format!("{}-{format}.txt", spec.name)), bytes)?;
    }
    let measurements = measure(binary, baseline, &repo, spec, &report, samples)?;
    println!(
        "{}: {} changed files; {} actions; {:.2} ms median",
        spec.name,
        changed.len(),
        report["perFile"].as_array().map_or(0, Vec::len),
        measurements["after"]["medianMs"]
            .as_f64()
            .unwrap_or_default()
    );
    Ok(
        json!({"name":spec.name,"url":spec.url,"old":spec.old,"new":spec.new,"files":changed.len(),"actions":report["perFile"].as_array().map_or(0,Vec::len),"fallbacks":report.get("fallbacks").cloned().unwrap_or_else(||json!([])),"measurements":measurements}),
    )
}

pub fn run(
    root: &Path,
    directory: &Path,
    baseline: Option<&Path>,
    samples: usize,
    fetch: bool,
) -> Result<()> {
    if samples < 2 {
        return Err("at least two samples required".into());
    }
    command(
        "cargo",
        &["build", "--release", "--locked", "-p", "differens"],
    )?;
    let binary = root
        .join("target/release")
        .join(format!("differens{}", std::env::consts::EXE_SUFFIX));
    let baseline = baseline.map(fs::canonicalize).transpose()?;
    let repositories: Vec<Repository> =
        serde_json::from_slice(&fs::read(root.join("benchmarks/real-repos.json"))?)?;
    let reports = repositories
        .iter()
        .map(|spec| {
            audit(
                root,
                directory,
                &binary,
                baseline.as_deref(),
                spec,
                samples,
                fetch,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let commit = String::from_utf8(git(root, &["rev-parse", "HEAD"])?)?;
    let result = json!({"sourceCommit":commit.trim(),"samples":samples,"warmupRuns":1,"filesystem":"warm","measure":"new process, Git reads, parsing, matching, correlation, narration, JSON stdout captured","arch":std::env::consts::ARCH,"os":std::env::consts::OS,"repositories":reports});
    fs::write(
        root.join("target/real-repo-audit.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_contract_verifier_rejects_lost_changes_and_fallbacks() {
        let change = json!({"filePath":"app.rs","description":"changed function","action":{"type":"Update"}});
        let movement = json!({"kind":"Function","name":"moved","fromFile":"old.rs","toFile":"new.rs","modified":false});
        let report = json!({"perFile":[change],"crossFileMoves":[movement],"fallbacks":[{"filePath":"app.rs","fallback":"line"}]});
        let file = json!({"filePath":"app.rs","changes":[{"description":"changed function","action":{"type":"Update"}}],"fallback":"line"});
        let trailer = json!({"crossFileMoves":report["crossFileMoves"]});
        let ndjson = format!("{file}\n{trailer}\n");
        validate_ndjson(&report, ndjson.as_bytes()).unwrap();
        assert!(validate_ndjson(&report, format!("{file}\n").as_bytes()).is_err());
        assert!(validate_ndjson(&report, b"{broken\n").is_err());
        let without_fallback =
            json!({"perFile":report["perFile"],"crossFileMoves":report["crossFileMoves"]});
        assert!(validate_ndjson(&without_fallback, ndjson.as_bytes()).is_err());
    }

    #[test]
    fn real_repository_expectations_detect_missing_files_or_named_changes() {
        let spec = Repository {
            name: "repo".into(),
            url: String::new(),
            old: String::new(),
            new: String::new(),
            expected: Expectation {
                file: "app.rs".into(),
                kind: "Function".into(),
                label: "run".into(),
            },
        };
        let report = json!({"perFile":[{"filePath":"app.rs","action":{"node":{"kind":"Function","label":"run"}}}],"crossFileMoves":[]});
        let changed = ["app.rs"].into_iter().collect();
        validate_report(&spec, &changed, &report).unwrap();
        assert!(
            validate_report(&spec, &["app.rs", "lost.rs"].into_iter().collect(), &report).is_err()
        );
        let mut report = report;
        report["perFile"][0]["action"]["node"]["label"] = json!("wrong");
        assert!(validate_report(&spec, &changed, &report).is_err());
    }
}
