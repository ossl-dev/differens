# Frozen generated grammars

These deterministic gzip/tar archives contain only the generated C parsers,
external scanners, required C headers, and upstream license files from the exact
npm versions in the pre-migration lockfile. They contain no JavaScript, npm
loader, runtime download, or grammar regeneration step. `build.rs` extracts them
with Rust libraries into Cargo's build directory and compiles with `cc`.

Swift's larger parser is packaged separately in `differens-grammar-swift` so
each publishable crate stays below the default registry package size limit.

`fixtures/grammar-manifest.json` in the monorepo records the original archive
URL and SHA-256, every vendored source file's SHA-256, ABI versions, license, and
the compressed vendored archive checksum. ABI 14 and 15 are accepted by the
pinned tree-sitter 0.25.1 runtime. All seventeen dialects have compiled semantic
smoke cases in `tests/grammar.rs`, including separate TypeScript and TSX cases.

Upgrades must replace one exact upstream artifact, refresh the manifest and
archive checksums, compare CST/extractor fixtures, and run all grammar and
adapter tests on every supported release platform. Build-time generation is
intentionally excluded so source releases parse the same syntax as CI.
