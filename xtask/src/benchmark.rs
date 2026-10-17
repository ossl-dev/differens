use crate::{Result, command};
use serde_json::json;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::Instant,
};

pub fn run(root: &Path, samples: usize) -> Result<()> {
    if samples < 2 {
        return Err("at least two samples required".into());
    }
    command(
        "cargo",
        &["build", "--release", "--locked", "-p", "differens"],
    )?;
    let directory = tempfile::tempdir()?;
    let mut old = String::new();
    for i in 0..200 {
        use std::fmt::Write;
        writeln!(
            old,
            "export function handler{i}(input: number): number {{ return input + {i}; }}"
        )?;
    }
    let new = old.replace("handler7(", "handleSeven(");
    let a = directory.path().join("old.ts");
    let b = directory.path().join("new.ts");
    fs::write(&a, &old)?;
    fs::write(&b, &new)?;
    let exe = root
        .join("target/release")
        .join(format!("differens{}", std::env::consts::EXE_SUFFIX));
    let mut times = Vec::with_capacity(samples);
    let mut expected = None;
    for i in 0..=samples {
        let start = Instant::now();
        let output = Command::new(&exe)
            .args([a.as_os_str(), b.as_os_str()])
            .arg("--format=json")
            .stdin(Stdio::null())
            .output()?;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
        }
        let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        if result.as_array().is_none_or(Vec::is_empty) {
            return Err("benchmark produced no semantic changes".into());
        }
        if let Some(ref expected) = expected {
            if expected != &output.stdout {
                return Err("nondeterministic benchmark output".into());
            }
        } else {
            expected = Some(output.stdout.clone());
        }
        if i > 0 {
            times.push(ms);
        }
    }
    times.sort_by(f64::total_cmp);
    let middle = times.len() / 2;
    let median = if times.len() % 2 == 0 {
        f64::midpoint(times[middle - 1], times[middle])
    } else {
        times[middle]
    };
    let p95 = times[times.len() - times.len() / 20 - 1];
    let result = json!({"case":"200 TypeScript functions, one rename","inputBytes":old.len()+new.len(),"oldInputBytes":old.len(),"newInputBytes":new.len(),"samples":samples,"warmupRuns":1,"medianMs":median,"p95Ms":p95,"measure":"native process startup + read + parse + match + narrate + JSON serialization","filesystem":"warm","arch":std::env::consts::ARCH,"os":std::env::consts::OS,"allMs":times});
    let destination = root.join("target/benchmarks.json");
    fs::write(&destination, serde_json::to_vec_pretty(&result)?)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
