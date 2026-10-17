# Command line

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

| Option | Behavior |
| --- | --- |
| `--format=terminal` | Human summary, default |
| `--format=json`, `--json`, `-j` | Machine JSON |
| `--format=markdown`, `--markdown`, `--md` | Markdown summary |
| `--format=llm`, `--llm`, `-l` | Compact line-oriented summary |
| `--format=ndjson` | Ordered file records, then optional move trailer |
| `--all` | Include every file in large human reports |
| `--jobs=N` | Native worker threads; zero selects up to two workers, leaving one CPU for the host |
| `--help` | Usage |
| `--version`, `-v` | Version |

Unknown flags and invalid formats are errors. Use `--` before file paths that begin with a dash. Successful comparisons, including comparisons with changes, exit zero. Input, Git, parsing setup, and output errors exit nonzero; a closed output pipe is handled normally.

The nearest repository configuration is `differens.toml` or `.differensrc.json`. It can set `format` and `driverExtensions`. Explicit flags take precedence. Git driver mode is an internal invocation boundary; applications should call the normal comparison syntax.

## Engine API

`differens-engine` supplies `DiffEngine::new(jobs)`, `stream(inputs)`, `diff_inline(&FilePair)`, `report_file`, `report`, and `load_config`. It reuses a native thread pool, preserves result ordering, and composes parsing, narration, and cross-file correlation. Its worker windows limit in-flight files/source bytes; individual oversized files and retained correlation candidates still affect memory usage.
