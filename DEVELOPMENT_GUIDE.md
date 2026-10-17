# Development guide

Differens is one Cargo workspace. Install the pinned toolchain from
`rust-toolchain.toml`, a C/C++ compiler for Tree-sitter/scanners, and Git for
repository integration tests. The lockfile belongs to the monorepo.

## Structure

```text
crates/differens-core/       validated arenas, matching, typed edits
crates/differens-tiers/      shared sequence engine and format/language adapters
crates/differens-narrate/    descriptions, grouping, output formatting
crates/differens-correlate/  cross-file move identity and similarity
crates/differens-git/        files, directories, Git subprocesses, driver setup
crates/differens-engine/     bounded worker windows, config, reporting
apps/cli/                   native differens executable
apps/docs/content/          CommonMark documentation and language examples
fixtures/                   frozen parity, corrections, grammar smoke inputs
xtask/                      Rust checks, benchmarks, docs, packaging, coverage
```

The core accepts immutable trees and has no parser or filesystem dependency. The
input crate retains original bytes and explicit file presence. Tiers create core
trees; narration and correlation consume actions. The engine composes those
libraries. Keep shared behavior in its owning crate rather than duplicating it
in CLI dispatch.

## Commands

```bash
cargo build --workspace --locked
cargo run -p differens -- before.rs after.rs
cargo test --workspace --locked
cargo test -p differens-core --no-default-features
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo doc --workspace --no-deps --locked
cargo xtask check
cargo xtask parity
cargo xtask docs
cargo xtask bench
cargo xtask package --dry-run
```

`cargo xtask coverage` uses `cargo-llvm-cov` and the pinned toolchain's LLVM tools.
Install that Cargo tool separately when running the coverage gate locally. Its
gate requires 95% line coverage and 90% function coverage. Check the coverage
report for the measured result.

Use focused crate tests during implementation, then complete workspace checks.
Tests exercise real temporary Git repositories, seeded sequence references,
frozen legacy outputs, explicit corrected cases, grammar dialects, and deep-tree
cleanup. Native package validation and published registry state are distinct.

## Invariants

- `TreeBuilder` receives children before parents in contiguous source-order
  postorder. IDs belong to one tree; use an owned `NodeRef` across result lifetimes.
- Content/structure hashes nominate candidates. Full topology and field checks
  establish equality. Keep UTF-16 hashing compatibility separate from UTF-8 spans.
- Preserve `None` versus empty values and explicit legacy metadata fields.
- Missing files are presence values. Git failures and unreadable inputs propagate
  errors; they do not become empty or unchanged files.
- Parser budgets and sequence work limits produce visible fallback metadata.
- Keep action/report order deterministic across worker counts.
- In-flight worker windows, caches, retained moves, and large individual files all
  contribute to memory use. Measure the full workload before changing limits.

## Adding a language or format

Pin grammar/runtime revisions and licenses, add build/feature wiring, register
extensions/dialects, and map CST kinds/labels in the tiers crate. Add valid,
malformed, Unicode, rename/move, and native artifact smoke tests. Preserve TS and
TSX as distinct grammar dialects. An extension classified as code is not semantic
coverage until a parser is linked and tested.

Data and markup adapters should retain semantic information: scalar types,
attributes, and nested structure. Share sequence matching and core matching;
avoid a second tree matcher inside an adapter. Parser output must satisfy arena
invariants and source-span conventions.

## Documentation

Edit `apps/docs/content/*.md` and nested CommonMark pages. Preserve existing page
slugs when possible and update `apps/docs/navigation.json` and `routes.json` when
adding or moving a page. `cargo xtask docs` builds static HTML under `target/site`
with Rust; API docs use `cargo doc`. No client JavaScript or external documentation
runtime is required. Source-language examples remain legitimate documentation.

## Commits and delivery

Match existing readable past-tense commit subjects:

- `Added Python extractor for async functions`
- `Fixed root insertion when the old tree is empty`
- `Replaced recursive tree walks with arena traversal`

Format before committing. Keep behavior changes fixture-backed and commits
reviewable. Dry-run packaging validates artifacts without publishing. Publish
crates in dependency order only through a deliberate release action. Document
supported targets from executed tests; cross-compilation alone does not prove
runtime support.

## Real repository audits

Pinned source revisions and named-change expectations are recorded in
`benchmarks/real-repos.json`. Fetching reads public Git objects; the audit does
not install repository dependencies or execute their code:

```bash
cargo xtask audit-repos --repos-dir target/audit-repos --fetch --samples 7
```

Each history checks all changed paths, expected named changes, JSON/NDJSON
agreement, and deterministic output with one and four workers. The manifest can
also require or forbid specific LLM facts to catch misleading summaries. Terminal,
Markdown, and LLM reports are saved under `target/audit-output` for inspection.
Measurements include a new native process, Git reads, analysis, and captured JSON
stdout. Results are written to `target/real-repo-audit.json`.

Pass `--baseline /absolute/path/to/previous/differens` to alternate old/new process
order and collect paired release measurements. Keep the baseline binary's source
revision with the recorded results. Intentional output corrections can change
raw action counts; validate file coverage and report quality alongside speed.

Reproduce isolated matcher and correlation stress measurements with:

```bash
cargo test -p differens-core --release --test performance -- --ignored --nocapture
cargo test -p differens-correlate --release --test store -- --ignored --nocapture
```

For repeat source-package verification during unpublished development, use a
fresh Cargo target directory. Cargo treats registry versions as immutable;
reusing its temporary package registry can otherwise select a cached older
archive with the same version. Native archive creation uses `cargo xtask package`.
