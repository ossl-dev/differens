# Native migration

The monorepo now uses a Cargo workspace for application code, tests, maintenance,
and documentation builds. Install the current checkout with:

```bash
cargo install --path apps/cli --locked
```

The executable is still `differens`. File/directory comparisons, working-tree and
commit-range modes, driver setup, language listing, five formats, and configuration
remain available. Native grammar linkage removes runtime grammar discovery from
the normal install path.

## Library boundary

Existing JavaScript imports are not source-compatible with Rust crates. Choose
`differens-core`, `differens-tiers`, `differens-narrate`, `differens-correlate`,
`differens-git`, or `differens-engine` for the required stage. Build trees with
`TreeBuilder`; pass source bytes and explicit `SourcePresence` to tier routing.
Refer to the [core](/reference/core.html) and [tiers](/reference/tiers.html) APIs.

Historical package versions remain historical. This source migration does not
publish registry packages, update package metadata, or deploy documentation.
Native registry/archive availability follows a deliberate release.

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

## Operational changes

The CLI uses native worker threads and ordered windows. `--jobs=N` chooses
concurrency. Ordered windows cap work at 24 files with a soft 64 MiB source budget;
a single large file can exceed that budget. Cross-file candidates use an 8 MiB
memory cache and spill to indexed temporary storage. Deep tree ownership and traversal are flat;
analysis budgets remain explicit.

Reinstall a Git driver after moving the binary because local configuration records
its executable path. Use a retained previous release artifact for rollback. Native
speed/memory improvements require same-quality release measurements; changing the
implementation language does not establish a fixed speedup.

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
