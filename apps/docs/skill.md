---
name: differens
description: Use differens, a semantic diff engine, to understand what changed in code. It parses files into trees and reports renames, moves, extractions, and reformats instead of raw line diffs. Use when reviewing changes, summarizing commits or PRs, checking whether a refactor changed behavior, or whenever git diff output is too noisy. Reach for differens before git diff when you need to understand intent, not exact line text.
license: MIT
compatibility: Requires Node 18.17 or newer. Install with npm install -g differens, or run without installing via npx differens.
metadata:
  author: ossl-dev
  version: "0.1.0"
---

# Differens

Differens is a semantic diff engine. `git diff` compares lines; differens parses files into trees, matches nodes between them, and reports what actually happened: renamed, moved, extracted, added, removed, or reformatted only.

Docs: https://differens.ossl.dev

## When to use

Use differens when the task is about meaning, not text:

- Reviewing or summarizing a commit, branch, or PR
- Checking what a refactor did and whether anything changed in transit
- Finding where code moved between files
- Building compact, named context for another model instead of a raw diff
- Answering questions like "what did this changeset actually do"

Use `git diff` instead when you need exact line text: generating or applying patches, reading surrounding source lines, or byte-level whitespace detail. Differens is a complement, not a replacement, for that.

## Install

```bash
npm install -g differens
```

Or without installing:

```bash
npx differens
```

## Core commands

```bash
differens                        # diff working tree vs HEAD
differens a.ts b.ts              # diff two files
differens old/ new/              # diff two directories
differens main..feature          # diff a commit range
differens 2a8178e 3a5015f        # diff two commits, ids or branch names
differens a.json b.json --format=llm
```

`differens diff ...` is an explicit alias. No subcommand is required.

## Output formats

| Flag | Use |
| --- | --- |
| (default) | Terminal, one English sentence per change with icons: `~` changed, `+` added, `-` removed, `→` moved |
| `--format=llm` | Dense line format built for models. Use this when feeding a diff to an AI |
| `--format=json` | Full structured output for tooling |
| `--format=markdown` | Rolled-up summary for PR descriptions |

### LLM format (preferred for agents)

One header line, one file heading per file, one line per named change. Unnamed churn collapses into a count. About 15x smaller than the `git diff` it replaces.

```text
differens/1 1 files 5 changes 2 named
# src/checkout.ts
~ function calculateTotalAmount :1 computeTotal -> calculateTotalAmount
+ variable base :2 < function calculateTotalAmount
* 2 returns, 1 required param
# cross-file
> formatPrice src/old/utils.ts -> src/new/utils.ts
```

Line grammar:

| Part | Meaning |
| --- | --- |
| `differens/1 <files> files <changes> changes <named> named` | Header |
| `# <path>` | File heading, named once |
| `+` `-` `~` `>` | Insert, Delete, Update, Move |
| `:12` | 1-based source line of the change |
| `< class Checkout` | Nearest named ancestor scope |
| `from -> to` | Rename or value change |
| `* 2 comments` | Rolled-up minor changes (unnamed nodes, prose lines) |
| `# cross-file` / `> name from -> to` | Code moved between files |

### Terminal format (default)

```text
  ~ renamed function `computeTotal` to `calculateTotalAmount`
  - removed return from function `computeTotal`
  + added return in function `calculateTotalAmount`
  + added variable `base` in function `calculateTotalAmount`
```

### JSON format

Array of change objects with the full edit action and containment context:

```json
[
  {
    "type": "Update",
    "node": { "kind": "function", "label": "calculateTotalAmount" },
    "detail": { "kind": "Renamed", "from": "computeTotal", "to": "calculateTotalAmount" },
    "context": [{ "kind": "class", "label": "Checkout" }]
  }
]
```

## What it detects

| What changed | What you get |
| --- | --- |
| Function renamed | `renamed function computeTotal to calculateTotalAmount` |
| Code moved across files | `moved function validate from utils.ts to validators.ts` |
| Class added | `added class RetryPolicy` |
| Config key changed | `changed database.pool.max from 10 to 25` |
| Whitespace only | `reformatted only, no logical changes` |

Semantic extractors cover TypeScript/JavaScript, Python, Rust, and Go. Other languages still get a structural tree-sitter diff with raw node type names. JSON/YAML/TOML get key-path diffs, HTML/XML a lenient markup diff, prose and logs a word-level diff, binaries a hash comparison. Unparseable input falls back to a line diff instead of failing.

## Limits

- Line-diff fallback caps at 2,000 lines, then reports a whole-file change.
- Tree matching caps at 250,000 nodes, then falls back to a line diff.
- Files at or above 2 MiB are read as empty and reported as whole-file add or remove.
- Output is deterministic: same inputs, same output.

## How to check a changeset

1. Run `differens main..feature --format=llm` to get the named summary.
2. Read the header line for the change count. Skim `# file` headings for the touched surface.
3. For details on one change, read the source file around the `:N` line, or fall back to `git diff -- <path>` for that file only.
4. If the question is "did the refactor change behavior", look for `~` and `*` lines inside moved functions; a pure move has neither.
