# Native migration

Differens 0.3.0 uses Rust for the CLI, libraries, tests, and maintenance tools.
The TypeScript packages, Bun build, and JavaScript workers have been removed from
this checkout. Documentation is CommonMark rendered by `cargo xtask docs`.

## Switch the CLI

Build from this checkout with the pinned Rust toolchain and a C/C++ compiler:

```bash
cargo install --path apps/cli --locked
differens --version
differens languages
```

The executable is still named `differens`. File and directory comparisons,
working-tree and commit-range comparisons, configuration, Git driver setup, and
all five output formats remain available. Grammars are linked into the binary,
so running the installed CLI does not require Node, Bun, or a grammar download.

If your shell still finds an older installation, check `type -a differens` and
put Cargo's binary directory first on `PATH`, or remove the old installation
with the package manager that installed it. Verify that `differens --version`
reports the version in this checkout's `Cargo.toml`.

Rerun `differens install-git-driver` in each repository where you registered the
old driver. Git's local configuration stores the executable path; the native
installer also removes the old text-conversion settings while keeping unrelated
attributes.

Once a native release has been published, `cargo install differens --locked`
can install it from the Cargo registry. Existing npm releases contain the older
JavaScript implementation. Publishing native crates and deploying this
documentation are separate release steps.

## Move library integrations to Rust

JavaScript imports are not source-compatible with the Rust APIs. Choose a crate
for the stage your integration needs:

| Previous npm package | Rust crate | Entry points |
| --- | --- | --- |
| `@ossl-dev/differens-core` | `differens-core` | `TreeBuilder`, `NodeSpec`, `diff_trees` |
| `@ossl-dev/differens-tiers` | `differens-tiers` | `diff_with_tier`, `SourcePresence`, parsing APIs |
| `@ossl-dev/differens-narrate` | `differens-narrate` | `narrate`, `format_changes`, `OutputFormat` |
| `@ossl-dev/differens-correlate` | `differens-correlate` | `correlate`, `FileChanges`, `CorrelateOptions` |
| `@ossl-dev/differens-git` | `differens-git` | `GitRepository`, `FilePair`, input streams |
| CLI worker/report orchestration | `differens-engine` | `DiffEngine`, `report`, `report_file` |

Build immutable trees with `TreeBuilder` rather than constructing mutable nested
nodes. Pass original bytes to `diff_with_tier`; `SourcePresence` distinguishes an
empty file from a missing file. Rust spans use UTF-8 byte offsets, while serialized
code spans retain the earlier UTF-16 offsets. See the [core](/reference/core.html),
[tiers](/reference/tiers.html), and [machine output](/guides/machine-outputs.html)
references before replacing an integration.

The [tiers reference](/reference/tiers.html) includes a Rust example for
comparing source bytes. There is no JavaScript runtime wrapper in the
native workspace.

## Corrective differences

- Different invalid UTF-8 binary bytes remain different.
- Markup attributes such as `href` generate edits.
- Scalar changes such as numeric `1` to string `"1"` preserve their types.
- YAML nesting uses a format parser instead of a fixed indentation subset.
- I/O and Git failures propagate instead of silently becoming empty content.
- Unknown CLI flags and invalid format values fail with a useful error.
- Empty machine comparisons retain valid JSON/NDJSON contracts.

Ordinary matching/narration parity is checked against frozen fixture outputs.
Intentional corrections have their own fixtures. Inspect fallback metadata and
source around reported lines when evaluating a real changeset.

## Workers and storage

`--jobs=N` selects native worker threads. Zero, the default, selects one or two
workers based on available CPUs, leaving one CPU for the host when possible.
The engine processes at most 24 files per window with a soft 64 MiB source budget;
a single large file can exceed that budget. Cross-file candidates use an 8 MiB
memory cache before spilling to indexed temporary storage. Trees use flat
ownership and iterative traversal; analysis still has explicit work budgets.

Keep a previous release artifact if you need to roll back. The
[benchmarks guide](/guides/benchmarks.html) records the measured migration results
and their limits, along with commands to reproduce the audits.

## Post-migration audit corrections

The native audit also covers issues inherited from the previous implementation:

- Markup keeps trailing slashes in unquoted URLs and the order of mixed text.
- JSON5/TOML non-finite numbers use an explicit fallback rather than becoming null.
- TOML datetimes remain scalar strings; private-looking user keys remain data.
- C/C++ declarator syntax no longer becomes part of an identifier's name.
- Python decorators and class assignments retain named scopes.
- Go methods sharing a name match and render by receiver identity; matching cannot
  borrow a body from a different receiver when extracting a helper.
- Dirty, uninitialized, and unborn submodules preserve observable Git changes.
- LLM headers include cross-file moves and preserve raw counts after grouping.
- Structural body replacements retain their named function or method in LLM reports.
- Long value previews reveal the actual edit; embedded backticks remain valid Markdown.

Bounded line alignment uses unique unchanged anchors after its exact-work budget
expires. This avoids cascading positional edits without claiming a globally
minimal script. Performance evidence and reproducible commands are described in
[benchmarks](/guides/benchmarks.html).
