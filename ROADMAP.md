# Roadmap

Differens runs as a native Rust CLI with reusable library crates. The migration
and follow-up audit are implemented; release checks and product improvements
remain below.

## Current implementation

- Immutable postorder tree arenas, legacy-compatible hashes, verified topology,
  named/bottom-up matching, leaf/container recovery, and LIS sibling moves.
- Shared raw/prose sequences; code grammars and semantic mappings; typed
  JSON/JSONC/JSON5/YAML/TOML/INI/ENV trees; markup attributes; binary bytes/plugins.
- File, directory, working-tree, and commit-range inputs with explicit errors and
  presence values; Git driver registration preserving unrelated attributes.
- Cross-file exact/modified moves, narration/grouping, five output formats,
  native workers, configuration, ordered reports, and Mintlify documentation
  generated from CommonMark with Rust.
- Frozen compatibility fixtures, corrective regression cases, and native
  build/test/package tooling.

Corrected migration cases include invalid UTF-8 binary differences, HTML attribute
changes, scalar type-only changes, and nested YAML edits. The original application
runtime and build chain are replaced by Cargo/Rust; linked upstream parsers still
contain native C/C++ code.

## Recorded validation

- [x] Compare frozen legacy outputs and track intentional corrections separately.
- [x] Audit pinned Express, Flask, ripgrep, chi, and Prettier histories, covering
  all 99 changed paths, selected named facts, output formats, and worker ordering.
- [x] Record repeated native/JavaScript standalone measurements and paired
  native-before/native-after repository measurements.
- [x] Bound cross-file candidate retention with an 8 MiB cache and indexed
  temporary storage; measure matcher, correlation, and spill stress cases.

Commands, source revisions, measurements, and their limits are in the
[benchmark guide](apps/docs/content/guides/benchmarks.md). These local results do
not establish release readiness on other platforms.

## Release and performance validation

- [ ] Accumulate real-world beta changesets and classify unexplained differences.
- [ ] Publish repeated same-quality median/p95 and peak-memory comparisons against
  retained legacy baseline artifacts on stable hardware.
- [ ] Complete clean-machine runtime smoke tests on every promised release target.
- [ ] Exercise rollback with previous immutable artifacts before promoting a release.
- [ ] Validate registry crate ownership, dependency-order publication, and release
  archive installation before advertising a published native version.
- [ ] Evaluate persistent caches, parser retention, further candidate-storage
  improvements, and cancellation using measured workloads.

Native execution alone does not prove a fixed performance multiplier. Worker
windows bound in-flight work; retained correlation candidates and large files
still need explicit memory accounting. Candidate caps reduce ordinary matching
work but do not establish linear complexity for every degenerate tree.

## Product improvements

- [ ] Repository-level summaries that explain related edits together.
- [ ] Changeset grouping across moves, renames, and extraction candidates.
- [ ] Explicit extraction/refactoring classification with independent regression
  evidence, rather than inferring behavior from an inserted helper alone.
- [ ] Conservative optional AST canonicalization and comment/whitespace policies.
- [ ] Vue/Svelte/Astro/MDX composite parsing through tested language injections.
- [ ] More grammar coverage, format-specific binary plugins, and cross-format data
  comparison.
- [ ] Progress reporting, shell completions, and additional editor integrations.

## Longer-term exploration

- [ ] Incremental/editor services built on the shared engine.
- [ ] Native desktop semantic comparison views.
- [ ] Three-way semantic merge assistance.
- [ ] Optional local narrative models; deterministic edits remain authoritative.
- [ ] Browser/editor bindings where justified by the host environment.

Bindings for browser or JavaScript-hosted editors would be an explicit future
integration boundary. They are not retained runtime wrappers around the migrated
CLI. New platforms, deployment services, and inference runtimes require their own
design and validation.
