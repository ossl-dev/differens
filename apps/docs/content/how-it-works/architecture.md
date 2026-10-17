# Architecture

One Cargo monorepo contains six libraries, a native CLI, and Rust maintenance tooling.

```text
apps/cli -> differens-engine -> differens-tiers -> differens-core
                            -> differens-narrate -> differens-core
                            -> differens-correlate -> differens-core
         -> differens-git
xtask: fixtures, benchmarks, docs, and package checks
```

The Git/filesystem layer produces `FilePair` values with original bytes and explicit presence. The engine uses a reusable native thread pool to diff bounded windows while preserving input order. Tier routing chooses parsers from file paths and content; parser output uses the same immutable arena tree representation. The core computes edits; narration describes them; correlation recognizes cross-file candidates.

## Ownership

Each tree owns a flat postorder node arena. Actions carry `NodeRef` values sharing one `Arc<Tree>` owner. Matching state is separate. Parser state remains local to worker threads. Each worker reuses its parsers and a bounded parse cache within that thread.

Shallow projections keep update/move metadata compact on the wire while preserving internal tree identity. Insertions/deletions can retain subtrees for correlation. Candidate subtrees detach from unrelated tree nodes. An accounted 8 MiB cache spills to indexed temporary storage when exceeded; correlation loads candidates on demand. Source windows use a soft 64 MiB budget across at most 24 files, so one large file can exceed it.

## Failure boundaries

Git/ref/read errors propagate. Missing files are explicit presence values, not failed reads converted to empty content. Unsupported, malformed, or over-budget semantic inputs fall back to raw lines; invalid UTF-8 remains binary bytes. Fallback diagnostics are distinct from successful semantic matches.

Tree-sitter's runtime and generated grammar scanners are native upstream C/C++ dependencies linked through Rust. Rust owns first-party application code and tooling; it does not replace those parsers with new language implementations.

## Distribution and documentation

The CLI links its selected grammars at build time. Core-only library consumers avoid the grammar dependency graph. `cargo doc --workspace --no-deps` builds API documentation; `cargo xtask docs` renders these CommonMark pages to static HTML without a client script or JavaScript build step.
