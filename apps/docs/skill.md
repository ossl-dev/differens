---
name: differens
description: Use differens, a semantic diff engine, to understand what changed in code. It reports renames, moves, extractions, and reformats instead of line diffs. Use when reviewing or summarizing commits, branches, or PRs; checking what a refactor did; finding code that moved between files; diffing config or data files; or building compact change context for another model. Prefer over git diff when you need change intent, not exact line text.
license: MIT
compatibility: Requires Node 18.17+. Install: npm install -g differens, or run without installing: npx differens.
metadata:
  author: ossl-dev
  version: "0.1.0"
---

# Differens

Semantic diff engine. Parses files into trees, matches nodes, reports what happened: renamed, moved, extracted, added, removed, reformatted only. Docs: https://differens.ossl.dev

## Choose the right tool

| Need | Tool |
| --- | --- |
| Change intent: review, summary, refactor check, moved code, named changes | differens |
| Exact line text, patch generation or application, surrounding source lines | git diff |
| Full file content | Read the file |

Rule: differens first for "what did this changeset do". git diff only when you need raw text around a specific change.

## Install

```bash
npm install -g differens   # or: npx differens
```

## Commands

```bash
differens                        # working tree vs HEAD
differens a.ts b.ts              # two files
differens old/ new/              # two directories
differens main..feature          # commit range
differens 2a8178e 3a5015f        # two commits (id or branch)
differens a.json b.json --format=llm
```

`differens diff ...` is an alias for the same thing.

## Formats

| Flag | Use |
| --- | --- |
| `--format=llm` | Default choice for agents. ~15x smaller than the git diff it replaces |
| `--format=json` | Structured output for tooling |
| `--format=markdown` | Rolled-up summary for PR descriptions |
| `--format=ndjson` | One JSON object per file, streamed as results land |
| (none) | Terminal, one sentence per change, icons `~` changed `+` added `-` removed `→` moved |

`differens.toml` or `.differensrc.json` in the repo root sets the default format (`format = "llm"`) and the git driver extension list. Flags override it.

### LLM format

```text
differens/1 1 files 5 changes 2 named
# src/checkout.ts
~ function calculateTotalAmount :1 computeTotal -> calculateTotalAmount
+ variable base :2 < function calculateTotalAmount
* 2 returns, 1 required param
# cross-file
> formatPrice src/old/utils.ts -> src/new/utils.ts
```

| Token | Meaning |
| --- | --- |
| Header | `differens/1 <files> files <changes> changes <named> named` |
| `# <path>` | File heading, named once |
| `+` `-` `~` `>` | Insert, Delete, Update, Move |
| `:N` | 1-based source line of the change |
| `< kind name` | Nearest named ancestor scope |
| `from -> to` | Rename or value change |
| `* N kind(s)` | Rolled-up unnamed changes |
| `# cross-file` / `> name from -> to` | Code moved between files |

### JSON

```json
[{"type":"Update","node":{"kind":"function","label":"calculateTotalAmount"},
  "detail":{"kind":"Renamed","from":"computeTotal","to":"calculateTotalAmount"},
  "context":[{"kind":"class","label":"Checkout"}]}]
```

One object per change: `type` (Insert, Delete, Update, Move), `node` (kind, label), `detail` (change kind with from/to), `context` (ancestor chain, nearest first).

### Terminal

```text
  ~ renamed function `computeTotal` to `calculateTotalAmount`
```

## Detection

| Change | Output |
| --- | --- |
| Rename | `renamed function computeTotal to calculateTotalAmount` |
| Cross-file move | `moved function validate from utils.ts to validators.ts` |
| Add | `added class RetryPolicy` |
| Config change | `changed database.pool.max from 10 to 25` |
| Whitespace only | `reformatted only, no logical changes` |

Semantic extractors: TypeScript/JavaScript, Python, Rust, Go, C, C++, Java, Ruby, PHP, Swift, Kotlin, C#, Scala, Lua, shell. Other languages: structural diff with raw tree-sitter type names. JSON/YAML/TOML/INI/env: key-path diff. HTML/XML: lenient markup diff. Prose and logs: word-level diff with paragraph moves. Binary: hash comparison, upgradable via format plugins. Unparseable input: line diff fallback, never fails.

## Limits

None. Any file size, line count, or node count diffs for real.

| Situation | Behavior |
| --- | --- |
| Huge text file, small edit | Exact line or word diff, linear memory |
| Huge code file | Full tree match, no node cap |
| File rewritten, no shared lines | One whole-file Update |
| Determinism | Same inputs, same output. Re-running is safe but wasteful |

## Cost-efficient workflow

1. Run once per changeset: `differens main..feature --format=llm`. Cache the result.
2. Read the header line and `#` file headings first. Dig into only the files relevant to the question.
3. Need details on one change? Read the source file around the `:N` line. Only then `git diff -- <path>` for that file alone.
4. "Did the refactor change behavior?" Look for `~` and `*` lines on moved functions. A pure move has neither.
5. Do not re-run per question. Output is deterministic; reuse the cached result.
