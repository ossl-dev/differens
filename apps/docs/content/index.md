# Differens

Differens reports semantic changes in source code, structured data, markup, prose, and binary files. It matches parsed trees to identify updates, additions, removals, and moves, then renders terminal, Markdown, JSON, NDJSON, or compact LLM output.

```bash
differens before.rs after.rs
differens main..feature --format=llm
differens old/ new/ --format=json
```

The native Rust CLI and six reusable library crates live in one Cargo workspace. Tree-sitter grammars are linked into the executable. File and directory comparisons work without Git; repository modes use the installed Git executable.

Start with [installation](/getting-started/installation.html), then the [quickstart](/getting-started/quickstart.html). Read [language coverage](/languages/overview.html) before relying on a particular parser. Unsupported or over-budget semantic inputs fall back to line diffing, with fallback information exposed in reports.

The matcher is deterministic. Performance depends on parsing, tree shape, input size, output volume, and Git I/O; the Rust implementation does not imply a fixed speedup for every workload.
