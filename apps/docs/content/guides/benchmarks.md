# Benchmarks

Run native measurements in release mode:

```bash
cargo xtask bench
```

The runner generates 200 TypeScript functions and renames one function. It builds the release CLI, runs one warmup and 20 measured processes, and writes `target/benchmarks.json`. Timing includes startup, file reads, parsing, matching, narration, and full standalone JSON serialization. Output must stay deterministic. Other workloads need their own measurements.

## Fair comparisons

Use the same input bytes, parser grammars, semantic budgets, worker count, output mode, and output sink. Record fallback counts and output quality alongside latency. A faster run that reports fewer changes or falls back more often has not demonstrated an equivalent improvement.

Separate cold parser/cache startup from warm repeated parsing. Measure Git discovery/blob reads, parsing, CST conversion, matching, correlation, narration, serialization, and stdout when diagnosing end-to-end latency. Include all processes in legacy memory measurements.

Use repeated samples on a quiet machine, reporting median, p95, and spread. Cover tiny invocations, every dialect, many-file changesets, wide/deep trees, repetitive syntax, rewrites, large prose/raw inputs, binary bytes, and correlation-heavy moves. Hard performance gates need a stable runner.

## Baseline and claims

Frozen legacy fixture provenance lives under `fixtures/parity`; benchmark metadata/results live under `benchmarks`. Existing legacy timings were single-run observations and do not establish a Rust speedup. Native speed and memory claims require reproducible release-build measurements at the same output quality. No fixed multiplier is promised.

The core has no default size cap. Tier analysis and sequence work have budgets; reports expose fallbacks. Peak memory includes parser caches, in-flight windows, outputs, and retained correlation candidates, not only the node arena.

## Migration measurement

`benchmarks/results/native-comparison.json` records one local macOS arm64
comparison against legacy revision `66f292a15bd494d30ff2311ecc02868262dae870`.
Both files total 29,163 bytes. Each runtime had one warmup and 20 measured
processes, using rotating runtime order and warm filesystem caches. All runs
produced exactly equal decoded JSON, including full action trees.

| Runtime | Median | p95 |
| --- | ---: | ---: |
| Native Rust release | 10.52 ms | 11.51 ms |
| Bun 1.4.0, legacy source CLI | 75.61 ms | 89.47 ms |
| Node 22.14.0, bundled legacy CLI | 109.33 ms | 114.47 ms |

This case was about 7.2 times faster than Bun and 10.4 times faster than Node.
It measures one small standalone comparison, including the removed legacy Git
probes for absolute file paths. It does not establish those gains for repository
scans, every language, peak memory, or cold disk reads. Grammar initialization
occurs in every new process; the process-local parser cache is not reused.

To reproduce the baseline, use a separate checkout of the recorded legacy
revision with its locked dependencies. Generate inputs using the native benchmark
runner's input generator in `xtask/src/benchmark.rs`, preserve the same absolute paths, and compare each
legacy invocation against the release binary with `--format=json`. The Node
baseline bundles the CLI for Node while retaining its native Tree-sitter modules.
Never compare the earlier single-shot library timers with process measurements.
