# Command line

Choose the comparison inputs and output format independently. File and directory
comparisons work without Git; repository modes use the installed Git executable.

```bash
differens                           # working tree against HEAD
differens before.rs after.rs        # two files
differens old/ new/                  # two directories
differens main..feature              # commit range
differens HEAD~1 HEAD                # two commit refs
differens diff before.rs after.rs    # explicit alias
differens languages
differens install-git-driver
```

## Comparison modes

| Invocation | Inputs |
| --- | --- |
| `differens` or `differens diff` | Working tree against `HEAD`, including untracked files |
| `differens <old> <new>` | Two files, or two Git refs when both resolve |
| `differens <old>/ <new>/` | Two directory snapshots by relative path |
| `differens old..new` | Two commit trees selected by the range |

Use `./` or an absolute path if a filename could also be a Git ref. `--` stops
option parsing and permits literal paths such as `-before.rs` or a file named
`languages` at the command boundary.

## Options

| Option | Behavior |
| --- | --- |
| `--format=terminal` | Human summary, default |
| `--format=json`, `--json`, `-j` | Machine JSON |
| `--format=markdown`, `--markdown`, `--md` | Markdown summary |
| `--format=llm`, `--llm`, `-l` | Compact line-oriented summary |
| `--format=ndjson` | Ordered file records, then optional move trailer |
| `--all` | Include every file in large human reports |
| `--jobs=N` | Native worker threads; zero selects one or two workers, leaving one CPU for the host when possible |
| `--help`, `-h` | Usage |
| `--version`, `-v` | Version |

Unknown flags and invalid formats are errors. Use `--` before file paths that begin with a dash. Successful comparisons, including comparisons with changes, exit zero. Input, Git, parsing setup, and output errors exit nonzero; a closed output pipe is handled normally.

## Subcommands

| Command | Purpose |
| --- | --- |
| `diff` | Explicit alias for normal comparison mode |
| `languages` | List compiled language coverage, levels, and extensions |
| `install-git-driver` | Register the installed binary in local Git config and update attributes |

For a small comparison from the shell:

```bash
printf 'export const retries = 3;\n' > before.ts
printf 'export const retries = 5;\n' > after.ts
differens before.ts after.ts
```

```text
  ~ changed variable `retries` (`3` → `5`)
```

To write a report or inspect selected records:

```bash
differens main..feature --format=markdown > changes.md
differens main..feature --format=json | jq '.crossFileMoves'
differens main..feature --format=ndjson | jq -c 'select(.filePath)'
differens --format=llm -- ./before.rs ./after.rs
```

## Exit behavior

Successful comparisons exit zero whether or not edits exist. For unchanged
standalone files, terminal output is `no logical changes`, JSON is `[]`, and
NDJSON has no records. Repository/range human reports use a context message such
as `nothing changed`; machine envelopes remain valid. Parseable output is not
replaced with a human sentence in a machine format.

Errors return nonzero and write diagnostics to stderr. Unknown flags, invalid
formats, unreadable inputs, incompatible file/directory pairs, and failed Git
commands are errors. A closed output pipe is handled normally. The internal
`--git-diff-driver` invocation accepts Git's seven external-driver arguments;
there is no legacy worker-process entry point to use in scripts.

## Configuration

Differens searches the current directory and then its parents for `differens.toml`
or `.differensrc.json`. In each directory it tries TOML first and uses the first
valid configuration it finds. You can set the default format and the extensions
registered by `install-git-driver`:

```toml
format = "markdown"
driverExtensions = ["rs", "ts", "tsx", "py"]
```

The equivalent `.differensrc.json` is:

```json
{
  "format": "markdown",
  "driverExtensions": ["rs", "ts", "tsx", "py"]
}
```

Explicit format flags override the configuration. Format shortcuts such as
`--json` take precedence over `--format`. Unreadable or malformed configuration
files do not stop comparisons; unsupported setting values are ignored. The TOML
loader also accepts the older unquoted `format = markdown` syntax.

`driverExtensions` affects Git driver registration, not the parsers compiled into
the binary. Run `differens languages` to check those parsers. Git driver mode is
an internal invocation; applications should use the normal comparison commands.

## Engine API

`differens-engine` supplies `DiffEngine::new(jobs)`, `DiffEngine::stream(inputs)`, the free function `diff_inline(&FilePair)`, `report_file`, `report`, and `load_config`. It reuses a native thread pool, preserves result ordering, and composes parsing, narration, and cross-file correlation. Its worker windows limit in-flight files/source bytes; individual oversized files and retained correlation candidates still affect memory usage.

### Write a complete changeset report

This example supplies an input pair directly, then uses the native engine's
ordered report path. It prints the resulting LLM report:

```rust
use differens_engine::{DiffEngine, ReportOptions, report};
use differens_git::FilePair;
use differens_narrate::OutputFormat;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pair = FilePair {
        old_path: "config.json".to_owned(), new_path: "config.json".to_owned(),
        old_source: br#"{"port":3000}"#.to_vec(),
        new_source: br#"{"port":8080}"#.to_vec(),
        old_exists: true, new_exists: true,
    };
    let engine = DiffEngine::new(1)?;
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    report(&engine, [Ok(pair)], OutputFormat::Llm, "nothing changed",
        ReportOptions { all: true }, &mut output, &mut diagnostics)?;
    print!("{}", String::from_utf8(output)?);
    Ok(())
}
```

```text
differens/1 1 files 1 changes 1 named
# config.json
~ leaf port < object root 3000 -> 8080
```
