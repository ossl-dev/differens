use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::Parser;
use differens_engine::{DiffEngine, ReportOptions, load_config, report, report_file};
use differens_git::{
    DRIVER_FLAG, FilePair, GitRepository, diff_directories_stream, diff_driver_command,
    is_directory, read_file_pair,
};
use differens_narrate::OutputFormat;

#[derive(Parser)]
#[command(
    name = "differens",
    about = "A semantic diffing engine",
    disable_version_flag = true,
    after_help = "Commands: diff, languages, install-git-driver\nExamples:\n  differens                       diff working tree vs HEAD\n  differens old.ts new.ts          diff files\n  differens old/ new/              diff directories\n  differens main..feature          diff commit range\n  differens HEAD~1 HEAD            diff two commits"
)]
struct Args {
    /// File paths, directories, commit refs, or an old..new range
    inputs: Vec<String>,
    /// Output format: terminal, json, markdown, llm, ndjson
    #[arg(long, value_name = "FORMAT")]
    format: Option<OutputFormat>,
    #[command(flatten)]
    aliases: FormatAliases,
    /// Show every file in large comparisons
    #[arg(long)]
    all: bool,
    /// Native worker threads; 0 selects up to two workers
    #[arg(long, default_value_t = 0)]
    jobs: usize,
    /// Show version number
    #[arg(short = 'v', long)]
    version: bool,
}

#[derive(clap::Args)]
struct FormatAliases {
    #[arg(short = 'j', long, conflicts_with_all = ["markdown", "llm"])]
    json: bool,
    #[arg(long, alias = "md", conflicts_with = "llm")]
    markdown: bool,
    #[arg(short = 'l', long)]
    llm: bool,
}

#[derive(Clone, Copy)]
struct DiffOptions {
    format: OutputFormat,
    jobs: usize,
    all: bool,
}

type CliResult = Result<(), Box<dyn std::error::Error>>;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Piping through head is normal; do not print a misleading fatal.
            if is_broken_pipe(error.as_ref()) {
                return ExitCode::SUCCESS;
            }
            eprintln!("fatal: {error}");
            ExitCode::FAILURE
        }
    }
}

fn is_broken_pipe(error: &(dyn std::error::Error + 'static)) -> bool {
    if error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
    {
        return true;
    }
    error
        .downcast_ref::<differens_engine::Error>()
        .is_some_and(|error| match error {
            differens_engine::Error::Io(error) => error.kind() == io::ErrorKind::BrokenPipe,
            differens_engine::Error::Json(error) => {
                error.io_error_kind() == Some(io::ErrorKind::BrokenPipe)
            }
            _ => false,
        })
}

fn run() -> CliResult {
    let raw: Vec<_> = std::env::args_os().skip(1).collect();
    if raw.first().is_some_and(|argument| argument == DRIVER_FLAG) {
        return git_driver(&raw[1..]);
    }
    let args = Args::parse();
    let literal_inputs = first_input_after_separator(&raw);
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let stderr = io::stderr();
    let mut diagnostics = stderr.lock();
    if args.version {
        writeln!(output, "differens v{}", env!("CARGO_PKG_VERSION"))?;
        return Ok(());
    }
    let cwd = std::env::current_dir()?;
    let config = load_config(&cwd);
    let format = if args.aliases.json {
        OutputFormat::Json
    } else if args.aliases.markdown {
        OutputFormat::Markdown
    } else if args.aliases.llm {
        OutputFormat::Llm
    } else {
        args.format.or(config.format).unwrap_or_default()
    };
    let mut inputs = args.inputs;
    match inputs
        .first()
        .map(String::as_str)
        .filter(|_| !literal_inputs)
    {
        Some("diff") => {
            inputs.remove(0);
        }
        Some("languages") if inputs.len() == 1 => return languages(&mut output),
        Some("install-git-driver") if inputs.len() == 1 => {
            return install_driver(&cwd, config.driver_extensions, &mut output);
        }
        Some("languages" | "install-git-driver") => {
            return Err(format!("usage: differens {}", inputs[0]).into());
        }
        _ => {}
    }
    handle_diff(
        &inputs,
        &cwd,
        DiffOptions {
            format,
            jobs: args.jobs,
            all: args.all,
        },
        &mut output,
        &mut diagnostics,
    )
}

fn languages(output: &mut impl Write) -> CliResult {
    writeln!(output, "supported languages:\n")?;
    for language in differens_tiers::list_languages() {
        writeln!(
            output,
            "  {} ({}, {}): {}",
            language.language,
            if language.level == "L6" {
                "semantic"
            } else {
                "generic"
            },
            language.level,
            language.extensions.join(", ")
        )?;
    }
    writeln!(
        output,
        "\nall other text files: raw (L1 line diff)\nbinary files: hash only (L0)"
    )?;
    Ok(())
}

fn install_driver(
    cwd: &Path,
    extensions: Option<Vec<String>>,
    output: &mut impl Write,
) -> CliResult {
    let repo = GitRepository::discover(cwd)?;
    let executable = std::env::current_exe()?;
    let executable = executable
        .to_str()
        .ok_or("executable path cannot be represented as UTF-8")?;
    repo.install_git_driver(&diff_driver_command(executable, &[DRIVER_FLAG]))?;
    let extensions = extensions.unwrap_or_else(|| {
        let mut extensions: Vec<_> = differens_tiers::list_languages()
            .into_iter()
            .flat_map(|language| {
                language
                    .extensions
                    .iter()
                    .map(|extension| (*extension).to_owned())
            })
            .collect();
        extensions.sort();
        extensions.dedup();
        extensions
    });
    let extensions: Vec<_> = extensions.iter().map(String::as_str).collect();
    let path = repo.write_git_attributes(&extensions)?;
    writeln!(
        output,
        "git diff driver installed.\nwrote {}: {} extensions now use the differens driver.\n`git diff` narrates those files instead of printing hunks.",
        path.display(),
        extensions.len()
    )?;
    Ok(())
}

fn handle_diff(
    inputs: &[String],
    cwd: &Path,
    settings: DiffOptions,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> CliResult {
    let engine = || DiffEngine::new(settings.jobs);
    let options = ReportOptions { all: settings.all };
    let format = settings.format;
    match inputs {
        [] => {
            let repo = GitRepository::discover(cwd).map_err(
                |_| "not in a git repository\nuse: differens diff <old> <new> for standalone mode",
            )?;
            report(
                &engine()?,
                repo.diff_working_tree_stream()?,
                format,
                "nothing changed",
                options,
                output,
                diagnostics,
            )?;
        }
        [range] if range.contains("..") => {
            let repo = GitRepository::discover(cwd)?;
            report(
                &engine()?,
                repo.diff_commit_range_stream(range)?,
                format,
                &format!("nothing changed in range: {range}"),
                options,
                output,
                diagnostics,
            )?;
        }
        [old, new] => {
            let old_directory = is_directory(old);
            let new_directory = is_directory(new);
            if old_directory && new_directory {
                report(
                    &engine()?,
                    diff_directories_stream(old, new)?,
                    format,
                    &format!("{old} and {new} are identical"),
                    options,
                    output,
                    diagnostics,
                )?;
            } else if old_directory || new_directory {
                return Err(format!("cannot diff a directory against a file: {old} {new}").into());
            } else {
                let repo = if can_be_git_ref(old) && can_be_git_ref(new) {
                    GitRepository::discover(cwd).ok()
                } else {
                    None
                };
                let refs = repo
                    .as_ref()
                    .map(|repo| {
                        Ok::<_, differens_git::Error>((
                            repo.resolve_ref(old)?,
                            repo.resolve_ref(new)?,
                        ))
                    })
                    .transpose()?;
                if let (Some(repo), Some((Some(old), Some(new)))) = (repo, refs) {
                    let range = format!("{old}..{new}");
                    report(
                        &engine()?,
                        repo.diff_commit_ids_stream(&old, &new)?,
                        format,
                        &format!("nothing changed in range: {range}"),
                        options,
                        output,
                        diagnostics,
                    )?;
                } else {
                    report_file(&read_file_pair(old, new)?, format, output, diagnostics)?;
                }
            }
        }
        _ => {
            return Err(
                "usage: differens diff [<old> <new>] [--format=json|markdown|llm|ndjson]".into(),
            );
        }
    }
    Ok(())
}

fn can_be_git_ref(input: &str) -> bool {
    !Path::new(input).is_absolute() && !input.starts_with("./") && !input.starts_with("../")
}

fn first_input_after_separator(arguments: &[std::ffi::OsString]) -> bool {
    let mut option_value = false;
    for argument in arguments {
        if option_value {
            option_value = false;
            continue;
        }
        if argument == "--" {
            return true;
        }
        if argument == "--format" || argument == "--jobs" {
            option_value = true;
            continue;
        }
        if !argument
            .to_str()
            .is_some_and(|argument| argument.starts_with('-'))
        {
            return false;
        }
    }
    false
}

fn git_driver(args: &[std::ffi::OsString]) -> Result<(), Box<dyn std::error::Error>> {
    if args.len() < 7 {
        return Err(format!("usage: differens {DRIVER_FLAG} <path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode>\ngit supplies these; it is not meant to be run by hand").into());
    }
    let path = args[0]
        .to_str()
        .ok_or("Git path cannot be represented as UTF-8")?;
    let old_path = PathBuf::from(&args[1]);
    let new_path = PathBuf::from(&args[4]);
    let old_exists = args[3] != "000000" && old_path != std::path::Path::new("/dev/null");
    let new_exists = args[6] != "000000" && new_path != std::path::Path::new("/dev/null");
    let read = |path: &PathBuf, exists| {
        if exists {
            std::fs::read(path)
        } else {
            Ok(Vec::new())
        }
    };
    let pair = FilePair {
        old_path: path.to_owned(),
        new_path: path.to_owned(),
        old_source: read(&old_path, old_exists)?,
        new_source: read(&new_path, new_exists)?,
        old_exists,
        new_exists,
    };
    report_file(
        &pair,
        OutputFormat::Terminal,
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    )?;
    Ok(())
}
