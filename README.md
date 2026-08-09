# Differens

A diff engine that tells you what actually happened to your code.

`git diff` compares lines. That was a good idea in 1974, but it has no idea what those lines mean. Rename a function and you get a deletion plus an addition. Move a block of code across files and you get two unrelated chunks of noise. Reformat a file and you get "everything changed." It works, but it makes you do the thinking.

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

## Quick start

```bash
# Install
bun install
bun run build

# Diff two files
bun run apps/cli/src/index.ts diff old.ts new.ts

# Coming soon:
# differens diff                    # working tree vs HEAD (git mode)
# differens diff main..feat         # commit range
# differens install-git-driver      # register as git difftool
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
├── docs/
└── plan.md           # detailed design document
```

## Design principles

- **Algorithm first, AI optional.** Turning AI off removes only narrative polish, never a feature.
- **Deterministic core.** Same inputs, same output, every time. CI-safe by design.
- **Graceful degradation.** Every tier falls back to the one below it. No hard failures.
- **Git-aware, not git-dependent.** Everything works standalone; git is a convenience layer on top.
- **Fast enough for every commit.** Target: under 100ms overhead per typical file.

## Status

Early stage. Working through [plan.md](plan.md) toward Milestone 0: diff core + JSON/YAML adapters + TypeScript extractor + git difftool integration.

## Prior art worth reading before contributing

- [difftastic](https://github.com/Wilfred/difftastic) -- tree-sitter structural diff in Rust. Closest existing tool.
- [GumTree](https://github.com/GumTreeDiff/gumtree) -- the original top-down/bottom-up AST matching algorithm (Falleri et al., 2014)
- [mergiraf](https://github.com/Wilfred/difftastic/wiki) -- tree-sitter AST merging, the natural next problem after diffing

## License

MIT
