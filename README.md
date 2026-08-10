# Differens

A diff engine that tells you what actually happened to your code.

`git diff` compares lines. The line-diff approach dates back to the original Unix `diff` in 1974, and it still has no idea what those lines mean. Rename a function and you get a deletion plus an addition. Move a block of code across files and you get two unrelated chunks of noise. Reformat a file and you get "everything changed." It works, but it makes you do the thinking.

Differens parses your code into trees, matches nodes between them, and tells you what changed in terms you actually use: *renamed*, *moved*, *extracted*, *added*, *removed*, *reformatted only*.

## How it works (the short version)

1. **Parse** both sides into a structured tree using tree-sitter
2. **Match** nodes between trees with a top-down/bottom-up algorithm (GumTree lineage)
3. **Emit** a typed edit script: Insert, Delete, Update, Move
4. **Narrate** the edit script into readable output

The core is deterministic. Same inputs produce the same output every time. No model runs anywhere in the pipeline.

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
npm install -g differens
```

Or run it without installing:

```bash
npx differens
```

Node 18.17 or newer. The tree-sitter grammars ship as prebuilt binaries for the
common platforms, so there is nothing to compile.

The same build is published under the ossl scope as
[`@ossl/differens-cli`](https://www.npmjs.com/package/@ossl/differens-cli).
Identical package, identical `differens` command; install whichever name you
prefer, not both.

<details>
<summary>From source, or as a standalone executable</summary>

```bash
bun install
bun run apps/cli/src/index.ts <inputs>

# single-file executable
bun build apps/cli/src/index.ts --compile --outfile differens
```

The grammars are native addons and cannot be embedded in a `--compile`d
executable, so a standalone binary line-diffs source files unless it is run
from a directory where the grammars are installed. Use the npm install for
semantic diffing.

</details>

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
| `--format=llm` | Dense line format for AI tools: one line per change, with source line numbers. Roughly 15x smaller than the `git diff` it replaces |

LLM format is line-oriented, one file heading then one line per change.
Unnamed churn (comments, prose lines, bare expressions) collapses into a count,
and every named change carries its source line, so a model can read the twenty
lines around a change instead of the whole file:

```
differens/1 3 files 380 changes 113 named
# apps/cli/src/index.ts
+ function runWorker :373
- function mapWithConcurrency :313
~ function report :141 handleGitDiff -> report
* 12 comments, 3 expressions
# config/app.json
~ leaf port :14 < object database 3000 -> 8080
# cross-file
> validate utils.ts -> validators.ts
```

Ops are `+` added, `-` removed, `~` changed, `>` moved, `*` rolled-up count.
`:N` is the source line and `< Kind name` is the enclosing scope.

On this repo's own 14-file changeset that format is 6.5KB against 100KB of
`git diff`.

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
│   ├── narrate/      # template engine: edit script -> English, output formats
│   ├── git/          # git integration: difftool, diff driver, directory walk
│   └── tsconfig/     # shared TypeScript config
└── apps/
    └── cli/          # the differens command line tool
```

## Design principles

- **Deterministic core.** Same inputs, same output, every time. CI-safe by design.
- **Graceful degradation.** Every tier falls back to the one below it. No hard failures.
- **Git-aware, not git-dependent.** Everything works standalone; git is a convenience layer on top.
- **Fast enough for every commit.** Target: under 100ms overhead per typical file.

## Status

Milestone 0 shipped: GumTree-lineage matching core (53-bit Merkle hashing, postorder
index, Dice bottom-up, LIS-minimised moves), JSON/YAML/TOML adapters, tree-sitter code
adapter with TypeScript/Python/Rust/Go extractors, git integration (working tree, commit
ranges, commit pairs, batched blob reads), directory diffing, a cross-file correlator, and
the narration engine with terminal/markdown/json/llm output. Per-file diffs run on a
process pool. ~100 tests, zero failures. Published on npm as
[`differens`](https://www.npmjs.com/package/differens), runs on Node.

## Prior art worth reading before contributing

- [difftastic](https://github.com/Wilfred/difftastic) -- tree-sitter structural diff in Rust. Closest existing tool.
- [GumTree](https://github.com/GumTreeDiff/gumtree) -- the original top-down/bottom-up AST matching algorithm (Falleri et al., 2014)
- [mergiraf](https://github.com/Wilfred/difftastic/wiki) -- tree-sitter AST merging, the natural next problem after diffing

## License

MIT
