# Contributing

Use the pinned Rust toolchain, Cargo, a C/C++ compiler, and Git. The monorepo shares dependencies and lints through its root `Cargo.toml`.

```bash
cargo build --workspace --locked
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo doc --workspace --no-deps --locked
cargo xtask docs
```

Run a focused crate first while iterating, then required workspace checks. Core-only feature builds must remain independent of grammar dependencies:

```bash
cargo test -p differens-core --no-default-features
cargo run -p differens -- before.rs after.rs
```

## Code organization

`differens-core` owns tree invariants, matching, and actions. `differens-tiers` owns format/language adapters and sequence algorithms. `differens-git` owns fallible byte-preserving inputs. `differens-narrate` owns prose/formatting; `differens-correlate` owns cross-file identity. `differens-engine` composes them and the CLI supplies argument parsing and output streams.

Add shared behavior to the owning crate rather than duplicating it in the CLI. Keep parser-specific cases out of the matcher. Propagate I/O errors, preserve bytes until classification, and avoid recursive ownership for adversarial trees.

## Adding a language extractor

Add the pinned grammar and feature/build wiring to `crates/differens-tiers`, then map its CST kinds and declaration labels in the code adapter's extractor module. Register its extensions/dialect, and add valid, malformed, Unicode, rename, move, and packaged grammar smoke tests. Code classification alone does not count as semantic coverage.

## Fixtures and corrections

Frozen parity cases preserve existing behavior. Corrective fixtures document intentional fixes separately. Add regression cases for changed behavior and keep output ordering deterministic. Seed randomized tests and check sequence alignment against an independent small-input reference.

## Commits and reviews

Follow existing human-readable past-tense subjects, such as `Added Python extractor for async functions` or `Fixed root insertion when the old tree is empty`. Keep commits reviewable and run formatting before committing. Document validation and limits without unsupported performance claims.

## Documentation and packaging

Edit CommonMark under `apps/docs/content`, then run `cargo xtask docs`. Keep navigation/routes and crate API examples consistent with source. `cargo xtask package --dry-run` validates packaging; publishing registries or releases is a separate deliberate action.
