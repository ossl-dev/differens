# Installation

Build Differens with the Rust toolchain pinned in `rust-toolchain.toml`, Cargo,
and a C/C++ compiler for Tree-sitter and its grammar scanners. Install Git to
compare repositories or register the Git diff driver.

## From a checkout

```bash
git clone https://github.com/ossl-dev/differens.git
cd differens
cargo install --path apps/cli --locked

differens --version
differens languages
```

For development, use `cargo run -p differens -- <inputs>` from the checkout. Cargo downloads dependencies during the initial build; the installed CLI performs local comparisons without a language runtime or a grammar download.

## Registry installation

Once the native release is published:

```bash
cargo install differens --locked
```

Use the checkout installation for an unpublished revision. Previous npm releases remain historical releases and do not contain the native migration. Existing JavaScript library imports must migrate to Rust crate APIs.

## Libraries

The workspace contains `differens-core`, `differens-tiers`, `differens-narrate`, `differens-correlate`, `differens-git`, and `differens-engine`. Depend on the stages you need. `differens-core` supports `default-features = false` for consumers that do not need JSON serialization or parsers.

Start with the [core reference](/reference/core.html) for tree construction or
[tiers](/reference/tiers.html) to compare source bytes. If you used an npm release,
follow the [migration guide](/guides/native-migration.html) for CLI replacement,
Git driver setup, and the Rust equivalents of the JavaScript packages.
