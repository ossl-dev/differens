# Installation

Differens is a native executable. Building from source needs the pinned Rust toolchain, Cargo, and a C/C++ compiler for the linked Tree-sitter runtime and grammar scanners. Git is needed for repository comparisons and driver registration.

## From a checkout

```bash
git clone https://github.com/ossl-dev/differens.git
cd differens
cargo build --release --locked
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

See the [reference](/reference/core.html) for tested API shapes. Native package availability and platform artifacts depend on the actual published release; building this checkout does not publish packages.
