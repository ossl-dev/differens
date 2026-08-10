# Development guide

Differens is a semantic diffing engine: it parses code into trees, matches nodes structurally, and tells you what actually changed -- renamed, moved, extracted, reformatted -- instead of which lines changed.

## Code structure

```
differens/
├── packages/
│   ├── core/          # Node hashing + GumTree-style tree matching
│   ├── tiers/         # Content router + 6 tier adapters (T0-T5)
│   │   ├── binary.ts  # T0: binary detection (hash-only)
│   │   ├── raw.ts     # T1: LCS line diff (safety net)
│   │   ├── prose.ts   # T2: word-level prose diff
│   │   ├── markup.ts  # T3: HTML/XML tree parser
│   │   ├── data.ts    # T4: JSON/YAML/TOML value trees
│   │   └── code/      # T5: tree-sitter CST + per-language extractors
│   │       ├── extractor.ts    # LanguageExtractor interface
│   │       ├── typescript.ts   # TS/JS semantic extractor
│   │       ├── python.ts       # Python semantic extractor
│   │       ├── rust.ts         # Rust semantic extractor
│   │       └── go.ts           # Go semantic extractor
│   ├── narrate/       # Template engine: edit actions -> English
│   ├── correlate/     # Cross-file move/rename detection
│   ├── git/           # Git shell-out integration
│   └── tsconfig/      # Shared TypeScript config
├── apps/
│   └── cli/           # The `differens` command
├── turbo.json         # Turborepo pipeline
├── biome.json         # Formatter + linter config
└── package.json       # Root workspace config
```

**Starting point:** `packages/core/src/index.ts` for the matching algorithm. `packages/tiers/src/index.ts` for the content router and adapter pipeline.

**Pipeline:** Content router -> Tier adapter -> Diff core -> Cross-file correlator -> Narration engine -> Output formatter. Each tier can fall back to the tier below it. The diff core never cares where its input came from (git, two files, two directories).

## Prerequisites

- **Bun** >= 1.3. Verify: `bun --version`
- Git (for git integration tests)

```bash
bun install
```

## Building

```bash
bun run build        # Build all packages
bun run typecheck    # TypeScript check across all packages
```

## Running the CLI

**From source (dev):** no build step needed, Bun runs TypeScript directly.

```bash
bun run apps/cli/src/index.ts <inputs>
```

**From the built bundle:** same code, just compiled.

```bash
bun run build --filter=differens
./apps/cli/dist/index.js <inputs>
```

**Standalone executable:** single file with the Bun runtime embedded, no dependencies.

```bash
bun build ./apps/cli/src/index.ts --compile --outfile differens
./differens <inputs>
```

**Published on npm:** `npm install -g differens`, then:

```bash
differens <inputs>
```

## CLI usage

The CLI is the diff, no subcommand:

```bash
differens                        # diff working tree vs HEAD
differens a.ts b.ts              # two files
differens old/ new/              # two directories
differens main..feature          # commit range
differens 2a8178e 3a5015f        # two commits by id or branch
differens a.json b.json --format=llm
```

Formats: terminal (default), `--format=json`, `--format=markdown`, `--format=llm` (compact JSON for AI tools with containment chains and before/after values).

## Tests

```bash
bun run test         # 100+ tests across 6 packages (zero failures)
bun run lint         # Biome lint all packages
bun run format       # Biome format all packages
```

Per-package:
```bash
bun test packages/core/src/
bun test packages/tiers/src/
```

## Architecture notes

**One diff core, many adapters.** There is exactly one tree-matching algorithm (GumTree lineage: top-down isomorphic matching + bottom-up container matching + Chawathe edit scripts). Every tier is a parser that produces a Node tree for that algorithm to consume.

**Graceful degradation.** Unparseable code falls back to generic tree-sitter CST diff. That falls back to LCS line diff. That falls back to byte-level hash comparison. The tool never crashes or refuses to produce an answer.

**64-bit FNV-1a hashing.** Content hash and structure hash are computed bottom-up (Merkle-style) per node. Content hash covers kind + label + value + children's content hashes. Structure hash covers kind + children's structure hashes (ignores label/value). Birthday bound at 50k nodes: ~0.000007% collision chance.

**Deterministic core.** Same inputs produce the same output every time. CI-safe by design. The optional AI layer (post-v1) adds narrative polish on top of the already-computed result.

**Algorithm first, AI optional.** Turning AI off removes only prose style, never a feature or correctness.

## Making changes

1. Pick or open an issue
2. Branch from `main`
3. Write code + tests. Every behavior change gets a test
4. Run `bun run test` -- must be all green
5. Run `bun run lint` -- must be clean
6. PR against `main`

**Commit style**: Human-readable, past-tense, lowercase after first word.

Good:
- `Added Python extractor for async/await node types`
- `Fixed root-level insertion not emitted when parent is null`
- `Replaced recursive tree walk with iterative stack to avoid stack overflow`

Avoid:
- `fix: root insert` (too terse)
- `Implemented comprehensive solution for edge case handling in the tree matching subsystem` (too verbose)

**Formatting**: Biome handles this. `bun run format` before committing, or let your editor do it on save.

## Adding a language extractor

1. Create `packages/tiers/src/code/<language>.ts`
2. Implement the `LanguageExtractor` interface from `extractor.ts`
3. Map tree-sitter node types to canonical concepts (Function, Class, Method, Import, etc.)
4. Register the extractor in `code/index.ts` `ensureInitialized()`
5. Add tests in `packages/tiers/src/index.test.ts`
6. Run `bun test packages/tiers/src/`

Languages without extractors still work at the generic level -- structural diff with raw tree-sitter node type labels. The extractor only adds human-readable concept names.

## Adding a tier adapter

1. Create the adapter in `packages/tiers/src/`
2. It must produce a `Node` tree (see `packages/core/src/index.ts` for the interface)
3. Register it in `packages/tiers/src/index.ts` `diffWithTier()` switch statement
4. Add to `classifyFile()` if it has specific file extensions
5. The tier number should reflect its position on the abstraction ladder (T0=bytes, T5=code)
6. Tests in `packages/tiers/src/index.test.ts`
