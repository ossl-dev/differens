# Differens

A diff engine that tells you what actually happened to your code.

`git diff` compares lines. The line-diff approach dates back to the original Unix `diff` in 1974, and it still has no idea what those lines mean. Rename a function and you get a deletion plus an addition. Move a block of code across files and you get two unrelated chunks of noise. Reformat a file and you get "everything changed." It works, but it makes you do the thinking.

Differens parses your code into trees, matches nodes between them, and tells you what changed in terms you actually use: *renamed*, *moved*, *extracted*, *added*, *removed*, *reformatted only*.

## How it works (the short version)

1. **Parse** both sides into a structured tree using tree-sitter
2. **Match** nodes between trees with a top-down/bottom-up algorithm (GumTree lineage)
3. **Emit** a typed edit script: Insert, Delete, Update, Move
4. **Narrate** the edit script into readable output (templates by default, optional local LLM for summaries)

The core is deterministic. Same inputs produce the same output every time. The optional AI layer adds narrative polish on top of the already-computed result -- turn it off and you lose nothing but prose style.

## What it handles

| What changed | What you get |
|---|---|
| Function renamed | `renamed function parse_config to load_config` |
| Code moved across files | `moved function validate from utils.ts to validators.ts` |
| Class added | `added class RetryPolicy` |
| Config key changed | `changed database.pool.max from 10 to 25` |
| Whitespace only | `reformatted only, no logical changes` |

And when it can't parse something, it falls back gracefully. Unparseable code falls back to structural tree diff. That falls back to line diff. That falls back to "changed / unchanged." The tool never refuses to give you an answer.

## Install

```bash
# Published on npm
bun add -g @ossl/differens-cli

# Or from source
bun install
bun run apps/cli/src/index.ts <inputs>

# Or a standalone executable, no dependencies
bun build apps/cli/src/index.ts --compile --outfile differens
```

The tree-sitter grammars are native addons and cannot be embedded in a
`--compile`d executable, so a standalone binary line-diffs source files unless
it is run from a directory where the grammars are installed. Use the npm
install or run from source for semantic diffing.

## Usage

Differens is a diff tool, so the CLI is the diff. No subcommand needed.

```bash
differens                        # diff working tree vs HEAD
differens a.ts b.ts              # diff two files
differens old/ new/              # diff two directories
differens main..feature          # diff a commit range
differens 2a8178e 3a5015f        # diff two commits by id or branch name
differens a.json b.json --format=llm
```

`diff` is kept as an explicit alias (`differens diff a.ts b.ts`).

### Output formats

| Flag | Use |
|---|---|
| (default) | Terminal, one line per change with scope: `changed value of port from 3000 to 8080 in object root` |
| `--format=json` | Raw SemanticChange array, for tooling |
| `--format=markdown` | Rolled-up summary, for PR descriptions |
| `--format=llm` | Compact flat JSON designed for AI tools: file, kind, name, containment chain, before/after values. Enough context to skip reading the raw diff |

LLM format example:

```json
{
  "file": "a.json",
  "kind": "leaf",
  "name": "port",
  "context": ["object root"],
  "action": "changed",
  "from": "3000",
  "to": "8080"
}
```

### Other commands

```bash
differens languages              # what's supported: semantic vs generic per language
differens install-git-driver     # register as a git difftool
differens --help                 # usage
differens --version              # version number
```

## Project structure

```
differens/
├── packages/
│   ├── core/         # tree representation, matching algorithm, edit scripts
│   ├── tiers/        # format adapters: markup, data, code, prose, composite
│   ├── correlate/    # cross-file move and rename detection
│   ├── narrate/      # template engine: edit script -> English
│   ├── ai/           # optional local LLM for summaries (offline, opt-in)
│   ├── git/          # git integration: difftool, diff driver
│   └── tsconfig/     # shared TypeScript config
├── apps/
│   ├── cli/          # the differens command line tool
│   └── desktop/      # Tauri desktop app (post-v1)
└── docs/
```

## Design principles

- **Algorithm first, AI optional.** Turning AI off removes only narrative polish, never a feature.
- **Deterministic core.** Same inputs, same output, every time. CI-safe by design.
- **Graceful degradation.** Every tier falls back to the one below it. No hard failures.
- **Git-aware, not git-dependent.** Everything works standalone; git is a convenience layer on top.
- **Fast enough for every commit.** Target: under 100ms overhead per typical file.

## Status

Milestone 0 shipped: diff core with 64-bit hashing, JSON/YAML/TOML adapters, tree-sitter code adapter with TypeScript/Python/Rust/Go extractors, git integration (working tree, commit ranges, commit pairs), cross-file correlator, narration engine with scope context, LLM output format. 100+ tests, zero failures.

## Prior art worth reading before contributing

- [difftastic](https://github.com/Wilfred/difftastic) -- tree-sitter structural diff in Rust. Closest existing tool.
- [GumTree](https://github.com/GumTreeDiff/gumtree) -- the original top-down/bottom-up AST matching algorithm (Falleri et al., 2014)
- [mergiraf](https://github.com/Wilfred/difftastic/wiki) -- tree-sitter AST merging, the natural next problem after diffing

## License

MIT
