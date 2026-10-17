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
| `--jobs=N` | Native worker threads; zero selects one or two workers, leaving one CPU for the host when possible |
| `--help` | Usage |
| `--version`, `-v` | Version |

Unknown flags and invalid formats are errors. Use `--` before file paths that begin with a dash. Successful comparisons, including comparisons with changes, exit zero. Input, Git, parsing setup, and output errors exit nonzero; a closed output pipe is handled normally.

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
