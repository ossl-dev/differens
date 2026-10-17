//! Reproducible project checks and native delivery tasks.
use clap::{Parser, Subcommand};
use std::{
    error::Error,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

mod benchmark;
mod docs;
mod package;
mod repositories;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Parser)]
#[command(about = "Differens workspace maintenance")]
struct Args {
    #[command(subcommand)]
    task: Task,
}
#[derive(Subcommand)]
enum Task {
    /// Format, lint, test, and build API documentation.
    Check,
    /// Run the frozen legacy and corrective behavior corpus.
    Parity,
    /// Measure native CLI startup and file analysis with reproducible inputs.
    Bench {
        #[arg(long, default_value_t = 20)]
        samples: usize,
    },
    /// Build the static documentation without JavaScript tooling.
    Docs,
    /// Produce a native release archive and checksums; never publish.
    Package {
        #[arg(long)]
        dry_run: bool,
    },
    /// Check Rust line/function coverage using cargo-llvm-cov.
    Coverage,
    /// Audit pinned real repository histories, formats, ordering, and release speed.
    AuditRepos {
        #[arg(long)]
        repos_dir: PathBuf,
        #[arg(long)]
        baseline: Option<PathBuf>,
        #[arg(long, default_value_t = 7)]
        samples: usize,
        /// Fetch the exact recorded revisions into the audit directory.
        #[arg(long)]
        fetch: bool,
    },
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask is in workspace")
        .to_owned()
}
fn command(program: &str, args: &[&str]) -> Result<()> {
    // Keep nested Cargo invocations on the toolchain that launched xtask,
    // even when another Cargo/Rust installation appears first on PATH.
    let executable = if program == "cargo" {
        std::env::var_os("CARGO").unwrap_or_else(|| program.into())
    } else {
        program.into()
    };
    let mut command = Command::new(&executable);
    if program == "cargo" && std::env::var_os("RUSTC").is_none() {
        let compiler = Path::new(&executable)
            .parent()
            .map(|directory| directory.join(format!("rustc{}", std::env::consts::EXE_SUFFIX)));
        if let Some(compiler) = compiler.filter(|path| path.is_absolute() && path.is_file()) {
            command.env("RUSTC", compiler);
        }
    }
    let status = command.args(args).current_dir(root()).status()?;
    if !status.success() {
        return Err(format!("{program} {} failed with {status}", args.join(" ")).into());
    }
    Ok(())
}
fn run() -> Result<()> {
    match Args::parse().task {
        Task::Check => {
            command("cargo", &["fmt", "--all", "--", "--check"])?;
            command(
                "cargo",
                &[
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--locked",
                    "--",
                    "-D",
                    "warnings",
                ],
            )?;
            command("cargo", &["test", "--workspace", "--locked"])?;
            command("cargo", &["doc", "--workspace", "--no-deps", "--locked"])?;
            docs::build(&root())
        }
        Task::Parity => command(
            "cargo",
            &["test", "--workspace", "--locked", "--test", "parity"],
        ),
        Task::Bench { samples } => benchmark::run(&root(), samples),
        Task::Docs => docs::build(&root()),
        Task::Package { dry_run } => package::build(&root(), dry_run),
        Task::Coverage => coverage(),
        Task::AuditRepos {
            repos_dir,
            baseline,
            samples,
            fetch,
        } => repositories::run(&root(), &repos_dir, baseline.as_deref(), samples, fetch),
    }
}
fn coverage() -> Result<()> {
    command(
        "cargo",
        &[
            "llvm-cov",
            "--workspace",
            "--exclude",
            "xtask",
            "--ignore-filename-regex",
            "/rustlib/",
            "--json",
            "--output-path",
            "target/coverage.json",
        ],
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root().join("target/coverage.json"))?)?;
    let totals = &value["data"][0]["totals"];
    let percent = |kind: &str| {
        totals[kind]["percent"]
            .as_f64()
            .ok_or_else(|| format!("missing {kind} coverage"))
    };
    let lines = percent("lines")?;
    let functions = percent("functions")?;
    println!("coverage: {lines:.2}% lines, {functions:.2}% functions");
    if lines < 95.0 || functions < 90.0 {
        return Err("coverage below 95% lines / 90% functions".into());
    }
    Ok(())
}
