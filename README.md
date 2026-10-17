# Differens

[![CI](https://github.com/ossl-dev/differens/actions/workflows/ci.yml/badge.svg)](https://github.com/ossl-dev/differens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Differens compares source trees and reports named changes: renamed functions,
added declarations, changed configuration values, and code moved between files.
It also handles markup, prose, raw text, and binary files.

The native Rust CLI and reusable libraries share one Cargo monorepo. Linked
Tree-sitter grammars provide code parsing; deterministic matching and narration
run locally without a model.

## Install from source

Use the pinned Rust toolchain, Cargo, and a C/C++ compiler for Tree-sitter and its
grammar scanners. Git is needed for repository modes.

```bash
cargo build --release --locked
cargo install --path apps/cli --locked
differens --version
differens languages
```

After the native package is published, `cargo install differens --locked` installs
it from the registry. Historical JavaScript packages remain separate releases;
JavaScript library imports must migrate to the Rust crate APIs.

## Compare

```bash
differens                           # working tree against HEAD
differens before.rs after.rs        # two files
differens old/ new/                  # two directories
differens main..feature              # commit range
differens HEAD~1 HEAD                # two commit refs
differens before.json after.json --format=llm
differens install-git-driver         # explicit local Git driver setup
```

`differens diff ...` is an explicit alias. `--jobs=N` chooses native worker
threads; zero selects one or two workers based on available CPUs, leaving one
CPU for the host when possible. `differens.toml` or `.differensrc.json` sets
the default format and Git driver extensions. Flags take precedence.

| Format | Use |
| --- | --- |
| `terminal` | Readable file and declaration summaries, default |
| `markdown` | Human summary suitable for a review description |
| `json` | Underlying narrated actions with structured context |
| `ndjson` | Ordered file records and an optional cross-file move trailer |
| `llm` | Compact line-oriented changes with source locations |

Select formats with `--format=...`. `--all` includes every file in large human
reports. Standalone file JSON is a change array; directory/repository JSON has
`perFile` and `crossFileMoves` arrays. Empty comparisons keep valid machine output.
Fallback diagnostics are exposed when semantic analysis uses lines.

## Libraries

| Crate | Responsibility |
| --- | --- |
| `differens-core` | Validated immutable tree arenas, hashes, matching, edit scripts |
| `differens-tiers` | Bytes, sequences, prose, data, markup, code grammars/extractors |
| `differens-narrate` | Narration, grouping, terminal/Markdown/JSON/LLM formatting |
| `differens-correlate` | Exact and modified cross-file move detection |
| `differens-git` | Fallible byte-preserving file, directory, and Git inputs |
| `differens-engine` | Native worker scheduling, config, and report orchestration |

```rust
use differens_tiers::{diff_with_tier, SourcePresence};
use differens_narrate::{narrate, format_changes, OutputFormat};

let result = diff_with_tier(
    br#"{"retries":3}"#,
    br#"{"retries":5}"#,
    "config.json",
    "config.json",
    SourcePresence::default(),
);
let changes = narrate(&result.changes, Some("config.json"));
println!("{}", format_changes(&changes, OutputFormat::Llm).unwrap());
```

Core-only consumers can disable `differens-core`'s default serialization feature
and avoid the grammar dependency graph. Tree-sitter's upstream runtime and
scanners contain C/C++; first-party application code and maintenance tooling are
Rust.

## Coverage and limits

The full build includes JavaScript, TypeScript/TSX, Python, Rust, Go, C, C++,
Java, Ruby, PHP, Swift, Kotlin, C#, Scala, Lua, and shell grammars with semantic
mappings. `languages` reports the exact compiled coverage. Other code extensions
can fall back to lines; filename classification alone does not imply a grammar.

Data adapters support JSON/JSONC/JSON5, YAML, TOML, INI, and environment files.
Scalar types are retained, nested YAML indentation is parsed, markup attributes
remain visible, and binary comparison preserves original bytes.

Core fingerprints retain legacy 53-bit folded FNV compatibility. Full content and
topology checks verify matches. Flat ownership and iterative traversal handle
deep trees without recursive cleanup. Tier source/node/depth limits and sequence
work budgets preserve a useful fallback on large or unsupported inputs.

Performance depends on parsing, tree shape, Git I/O, output volume, and worker
count. Rust enables native execution and shared memory; a fixed speedup or globally
minimal edit script is not promised. Cross-file matching remains a conservative
heuristic. Worker windows use a soft source budget; a single large file can exceed
that budget. Cross-file candidates use an 8 MiB memory cache, then
spill to indexed temporary storage; disk capacity must cover the retained edits.

## Develop

```bash
cargo run -p differens -- before.rs after.rs
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo doc --workspace --no-deps --locked
cargo xtask docs
cargo xtask bench
cargo xtask package --dry-run
```

Static documentation is generated from [CommonMark pages](apps/docs/content/index.md)
into `target/site`. See the [development guide](DEVELOPMENT_GUIDE.md),
[roadmap](ROADMAP.md), and [migration notes](apps/docs/content/guides/native-migration.md).

## License

MIT. See [third-party notices](THIRD_PARTY_LICENSES.md) for linked grammar/runtime
licenses.
