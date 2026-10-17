# Contributing

Clone the repository, run the Rust checks, then make a focused change with a
regression case. Use the toolchain pinned in `rust-toolchain.toml`, a C/C++
compiler for Tree-sitter, and Git for integration tests.

## Code of conduct

Assume good intent, give specific feedback, and keep discussions about the work.
Be patient with reviews. Harassment and personal attacks are not welcome in
issues, pull requests, or discussions.

## Get started

```bash
git clone https://github.com/ossl-dev/differens.git
cd differens
cargo build --workspace --locked
cargo test --workspace --locked
```

Run the CLI from the checkout without installing it:

```bash
cargo run -p differens -- before.rs after.rs
```

While iterating, run the crate or test you changed:

```bash
cargo test -p differens-core --locked
cargo test -p differens-tiers --locked --test labels
cargo check --workspace --locked
```

Tests cover core matching, grammar/adapter behavior, output presentation, and CLI
runs against temporary repositories. Git tests create disposable repositories;
they do not need to modify your own checkout. Frozen fixtures under
`fixtures/parity` preserve legacy behavior, while corrective fixtures and Rust
regression cases cover intentional fixes.

## Make a change

1. Pick or open an issue to explain the problem and expected behavior.
2. Branch from `main`, for example `git switch -c codex/fix-method-labels`.
3. Add the behavior and an appropriate regression case. Keep parser-specific rules
   in the adapter rather than the shared matcher.
4. Run focused tests, then the workspace checks below.
5. Open a pull request with the behavior change, its reason, and validation.

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test -p differens-core --no-default-features --locked
cargo test -p differens-tiers --no-default-features --locked
cargo doc --workspace --no-deps --locked
cargo xtask docs
```

Use `cargo fmt --all` to apply formatting. `cargo xtask check` runs the main
format/lint/test/documentation checks. `cargo xtask coverage` uses a separately
installed `cargo-llvm-cov` and requires at least 95% line and 90% function coverage.
Read the actual coverage report for the measured result.

### Commit style

Use readable past-tense subjects that explain what changed:

- `Added Python extractor for async functions`
- `Fixed root insertion when the old tree is empty`
- `Replaced recursive tree walks with arena traversal`

Keep each commit reviewable and include the relevant tests and documentation.

## Project structure

```text
apps/cli/                   argument parsing and the native executable
apps/docs/content/          documentation sources
apps/docs/docs.json         Mintlify site configuration
crates/differens-core/       trees, matching, typed edits
crates/differens-tiers/      parsers, language mappings, shared sequence algorithms
crates/differens-narrate/    descriptions, grouping, formatting
crates/differens-correlate/  declaration and file move identity
crates/differens-git/        filesystem/Git inputs and driver registration
crates/differens-engine/     native workers, configuration, report orchestration
fixtures/                   parity, corrections, grammar smoke inputs
xtask/                      checks, audits, benchmarks, documentation, packaging
```

Start with `crates/differens-core/src/lib.rs` for matching,
`crates/differens-tiers/src/router.rs` for routing, or
`crates/differens-engine/src/report.rs` for reports. Shared dependencies and lints
live in the root `Cargo.toml`; `Cargo.lock` belongs to the workspace.

## Adding a language extractor

1. Pin the upstream grammar, licenses, and checksums in the grammar manifests.
2. Add its archive/build wiring in `crates/differens-tiers/grammars` and `build.rs`.
   The separately packaged Swift grammar shows how a large grammar can be split.
3. Register the dialect in `src/code/grammar.rs` and its extensions in
   `src/code/mod.rs`; add path classification in `src/router.rs` if needed.
4. Map CST kinds in `src/code/concepts.rs` and declaration labels in
   `src/code/labels.rs`. Use internal identity hints only where the language needs
   them, such as receiver-scoped Go methods.
5. Add grammar smoke inputs and tests for valid, malformed, Unicode, rename, move,
   and identity cases. Keep TypeScript and TSX as distinct dialects.
6. Run grammar, label, adapter, engine, and packaged-artifact checks for the change.

Paths in steps 3 and 4 are relative to `crates/differens-tiers`. Code
classification alone is not grammar support. The installed CLI does not load a
JavaScript extractor or discover arbitrary grammars from disk.

## Adding a tier adapter

1. Add the parser or sequence adapter under `crates/differens-tiers/src`.
2. Build a validated immutable tree with `TreeBuilder`, or use the shared sequence
   helpers where the format is line/word based.
3. Add routing in `src/router.rs` and classification rules if the extension needs
   them. Reuse an existing tier when it fits the abstraction.
4. Preserve original bytes, explicit file presence, scalar types, and useful
   source coordinates. Retain nesting and non-label attributes.
5. Return parser failures or budget errors so the router can compare raw lines.
6. Add parser, malformed-input, Unicode, fallback, and report examples. Seed
   randomized cases and compare sequence alignment with a small independent
   reference where appropriate.

For binary formats, an in-process `BinaryDiffPlugin` may be enough. The
[tiers reference](/reference/tiers.html#binary-plugin-contract) shows the Rust
contract. Avoid putting a second tree matcher inside a format adapter.

## Documentation and packaging

The documentation is deployed on Mintlify. Keep `apps/docs/docs.json` and its
navigation in sync with the pages. Edit CommonMark under `apps/docs/content`, then
run `cargo xtask docs` and commit the generated MDX pages under `apps/docs` with
your changes. The same command builds an optional static preview in `target/site`.
The generator checks page coverage; CI checks that generated files match their
sources.

Compare documentation changes with the previous version before removing a
walkthrough or example. Replace an obsolete example with a working equivalent
and preserve the explanation it teaches. Run CLI examples against the native
binary, compile complete Rust examples, and capture actual output rather than
writing a plausible report by hand.

Run `mint validate` and `mint broken-links` from `apps/docs` with the Mintlify CLI
installed. Use `mint dev` for a local Mintlify preview. Keep page slugs, static
preview navigation/routes, and crate API examples consistent with the source.
`cargo xtask package --dry-run` validates application packaging; publishing crates
or releases is a separate action.

## Release process

Build and inspect before publishing:

```bash
cargo xtask package --dry-run
cargo xtask package
```

The first command validates the native release binary without writing an archive.
The second writes an archive and SHA-256 checksum under `target/packages`, including
licenses and the README. Neither command publishes crates or deploys the docs.

Publish native crates only through a deliberate release, in dependency order:
core and the grammar package before tiers, libraries before the engine, and the
CLI after its dependencies. Verify registry ownership, source packages, target
runtime smoke tests, and rollback artifacts before advertising release support.
The removed Bun/npm release script is not part of the native workflow.

## Where to ask questions

Use [GitHub issues](https://github.com/ossl-dev/differens/issues) for bugs, feature
requests, and behavior questions, or discuss code in the relevant pull request.
Include a small reproducer, the command, version, platform, and observed output.
`DEVELOPMENT_GUIDE.md` in the repository has additional invariants and audit
commands.
