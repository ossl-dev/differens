# Roadmap

Pick an unchecked box, open an issue saying you're working on it, send a PR. One item per PR.

---

## Phase 1 -- Ship what we have

- [x] Monorepo skeleton: Turborepo + Bun + TypeScript workspace
- [x] Diff core: 64-bit FNV-1a hashing, top-down isomorphic matching, bottom-up container matching, Chawathe edit scripts with Move actions
- [x] Content router: extension-based file classification (binary, raw, prose, markup, data, code)
- [x] T0 binary adapter: hash-only with byte-size delta reporting
- [x] T1 raw fallback: exact LCS line diff for small inputs, linear-space Myers for large, no size cap
- [x] T2 prose adapter: word-level diff for plain text, markdown, logs
- [x] T3 markup adapter: HTML/XML tree parser (lenient, fault-tolerant tokenizer)
- [x] T4 data adapter: JSON/YAML subset/TOML subset parser with key-path diff
- [x] T5 code adapter: tree-sitter integration with semantic extractors for TypeScript/JavaScript, Python, Rust, and Go
- [x] Narration engine: typed EditActions -> English sentences, per-language vocabulary (fn/def/func -> function)
- [x] Output formatters: terminal (colorized with icons), JSON (with BigInt serialization), markdown
- [x] Cross-file correlator: structure hash buckets, content hash exact matches, Jaccard similarity for modified moves
- [x] Git integration: shell-out difftool, working tree diff, commit range diff, diff driver registration
- [x] CLI: `differens diff`, `differens languages`, `differens install-git-driver`, `--format=json|markdown`, `--help`
- [x] Tests: 96 tests across 6 packages, zero failures
- [x] README, development guide, roadmap

**CI / infra**
- [x] GitHub Actions: test matrix on Bun latest, lint, typecheck
- [x] Biome check in CI (format + lint gates)
- [x] README badges (build status, license)
- [x] npm publishing: all six packages plus the CLI under `differens` and `@ossl-dev/differens-cli`

**Docs**
- [x] API reference per package
- [x] Quick start guide
- [x] Per-language extractor documentation
- [x] Troubleshooting page
- [x] "How it works" architecture deep-dive

---

## Phase 2 -- Breadth and hardening

- [ ] Expand semantic extractor coverage: C, C++, Java, Ruby, PHP, Swift, Kotlin, C#, Scala, Lua, shell
- [ ] L5 generic fallback: structural tree-sitter CST diff for any language with a grammar but no extractor
- [ ] Binary tier plugin interface (image perceptual diff, EXIF diff, ELF/PE symbol diff)
- [ ] JSON output mode in CLI (done at core level, needs CLI integration work)
- [ ] Git diff driver auto-registration (`differens install-git-driver` writes `.gitattributes`)
- [ ] Config file support (`.differensrc` or `differens.toml`): thresholds, AI on/off, default format
- [ ] Non-git directory diff mode: recursive walk, cross-directory rename detection
- [ ] Add remaining format detectors to content router: CSV/TSV, INI, ENV, GraphQL, Dockerfile

**Performance**
- [ ] Iterative tree traversal (replace recursion to prevent stack overflow on deep trees)
- [ ] 64-bit hash collision safety: optional content verification on hash match
- [ ] Content-addressed parse cache (keyed by blob hash)
- [ ] `maxFileSize` option actually enforced in tier pipeline (currently only maxNodes checked)
- [ ] Benchmark suite: typical file diffs, large file fallback, cross-file correlation at scale
- [ ] Worker pool for parallel parsing (Bun worker_threads)
- [ ] Streaming output for large diffs (SSE / chunked JSON)
- [ ] Regression test corpus (small/medium/large repo snapshots)

**Testing**
- [ ] Corpus tests against known refactors (extract method, rename, move file, reformat)
- [ ] Fuzz test the parser pipeline with random edits

---

## Phase 3 -- The actual differentiator

- [ ] Repository-level changeset summaries: one paragraph per commit/PR ("extracted validation into validators.ts")
- [ ] Markdown output mode optimized for PR descriptions and changelogs
- [ ] PR/commit range mode: `differens diff main..feature` with cross-file move narration
- [ ] File-level rename detection via git's `--find-renames` for directory and range diff modes
- [ ] Changeset grouping: cluster related changes (all the moves from one refactor, all the renames from another)
- [ ] Configurable AST canonicalization: normalize whitespace/comments, canonicalize identifiers (behind `--normalize` flag, conservative by default)

---

## Phase 4 -- AI layer and polish

- [ ] Optional local LLM for narrative summarization (offline, opt-in, `--ai` flag)
- [ ] Model packaging: fetch-on-first-use with local caching, or bring-your-own-model
- [ ] `--no-ai` default, AI strictly additive (never decides what changed, only narrates it)
- [ ] WASM-based inference runtime (no Python dependency, works with `bun build --compile`)
- [ ] Config file hot-reload
- [ ] Shell completions (bash, zsh, fish)
- [ ] Progress reporting for large changesets
- [ ] `--verbose` / `--quiet` / `--json` consistency across all commands

---

## Phase 5 -- Desktop and ecosystem

- [ ] Tauri desktop app: side-by-side semantic view, timeline browsing, AI explanation panel
- [ ] T6 composite file support: Vue SFC, Svelte, Astro, MDX code fences via tree-sitter injections
- [ ] Editor integrations: VS Code extension, potentially JetBrains
- [ ] WASM build of `@ossl-dev/differens-core` for in-browser diffing
- [ ] Homebrew / npm / JSR / `bun add` distribution of the CLI

---

## Stretch / post-v1

- [ ] 3-way semantic merge assistance (reusing the diff core, a la mergiraf)
- [ ] Format-specific T0 plugins: image perceptual diff, audio waveform diff, PDF text-layer diff
- [ ] Cross-format diffing (JSON against YAML, graphtage-style)
- [ ] Structural diff for binary formats via format-specific parsers (ELF, WASM, PE)
- [ ] GitHub Action: `ossl-dev/differens-action` for PR diff summaries
- [ ] GitLab CI integration

---

## Bugs and known issues

- O(n^2) bottom-up container matching at scale -- the `maxNodes` safety valve (50k) prevents worst case but large monorepo diffs may trigger it
- Myers middle-snake code removed; raw tier uses LCS with O(n*m) memory. Fast enough for <10k lines, capped above that
- Markup tokenizer is regex-based, not a full HTML5 parser -- tolerates everything but may misparse attribute values containing `>`
- YAML parser handles 2-space indentation only; 4-space YAML may drop nesting. Our YAML subset is intentional, not a full parser
- Leaf-level renames report as Delete+Insert, not Update/Renamed -- narration layer handles this by convention, but the core action is less precise than it could be
- Deeply nested structures (>10k depth) may stack overflow -- recursion safety valve not yet in place (mitigated by practical file limits)
- Tree-sitter grammar init is async and may race with the first `parseCode` call on cold start -- fixed by caching the init promise, but the async overhead remains
- `diffWorkingTree` uses `git diff HEAD --name-only` which misses staged-but-uncommitted changes (intentional: working tree vs HEAD is the documented contract)

---

## External recommendations assessment (2026-08-11)

**Already done / covered:**
- #2 Subtree fingerprints → 64-bit FNV-1a Merkle-style hashing in core
- #3 Multi-stage pipeline → Tier system (T0-T5) with graceful degradation
- #4 Move/rename detection → Cross-file correlator (structure hash buckets, Jaccard similarity)
- #14 Mixed tree-and-token diffing → Token diffs at leaves, tree matching for structure
- #17 Machine-friendly outputs → `--format=json`, `--format=markdown`, `--format=llm`
- #18 Config file → Already in Phase 2
- #6 Change-level metadata → Phase 3 changeset summaries
- #7 Natural-language summaries → Phase 4 `--ai` flag
- #8 Deterministic anchors → Phase 4 per-change metadata
- #9 Incremental cache → Phase 2 content-addressed parse cache
- #11 Lazy parsing → Tier fallback system
- #16 ML-enhancements → Phase 4 optional local LLM
- #19 Integration features → Phase 2 git driver, Phase 5 editor extensions
- #20 Diagnostics → Phase 2 benchmark suite
- #21 Extensibility → Phase 5 / stretch plugin marketplace
- #23 Benchmarking → Phase 2 benchmark suite

**Good ideas, added to roadmap below:**
- #1 AST normalization → Added to Phase 3 as "configurable AST canonicalization"
- #10 Parallelization → Added to Phase 2 performance: "worker pool for parallel parsing"
- #12 Memory/IO → Added to Phase 2: "streaming output for large diffs"
- #22 Corpus tests → Added to Phase 2: "regression test corpus"
- #25 Sandboxed parsing → Noted: tree-sitter grammars don't execute code; safe by design

**Skipped (over-engineered for current stage):**
- #5 TS-specific symbol mapping → Too narrow; TS extractor already gives good results
- #13 LSH/MinHash → Jaccard similarity sufficient; revisit if correlator becomes bottleneck
- #15 APTED tree edit distance → GumTree matching works; add only if precision gap proven
- #24 Telemetry → Premature; no distribution channel yet

---
## Ideas / maybe someday

- Streaming diff for very large files (process chunks, not whole file at once)
- `differens watch` -- filesystem watcher that diffs on save
- `differens story` -- generate a narrative commit message from the diff
- Structural-aware `git blame` that follows moves and renames through history
- Plugin marketplace for language extractors and binary format adapters
- Real-time collaborative diff review (like Google Docs but for code changes)
- Semantic code search: "find where this function signature was last changed"
- `differens lint` -- detect suspicious structural changes (function grew 10x, too many params added)
- `differens review` -- AI-assisted code review on top of the semantic diff
