---
name: differens
description: Use Differens to inspect named semantic changes, structured configuration edits, and moves across files. Use source reads or git diff for exact text and behavioral review.
license: MIT
compatibility: Native Differens CLI. Build this checkout with cargo install --path apps/cli --locked; Git is required for repository modes.
metadata:
  author: ossl-dev
  version: "0.3.0"
---

# Differens

Run once per changeset and reuse its deterministic output:

```bash
differens main..feature --format=llm
differens before.rs after.rs --format=json
differens old/ new/ --format=ndjson
```

The default invocation compares the working tree against HEAD, including untracked files. `diff` is an explicit alias. `languages` reports grammar availability. `install-git-driver` explicitly changes local Git configuration and `.gitattributes`.

Use LLM output for compact context, JSON for typed actions, NDJSON for ordered file records, and Markdown for human summaries. Source lines are one-based. Read source around each reported line when reviewing behavior; a semantic move does not prove that behavior stayed identical.

Standalone file JSON is a `SemanticChange` array with `action`, `description`, and optional `filePath`. Repository/directory JSON has `perFile` and `crossFileMoves` arrays, with optional fallback metadata. NDJSON contains file records and an optional move trailer. Empty machine outputs stay parseable.

Semantic parsing has source/node/depth budgets and may fall back to lines. Unsupported dialects also use lines. Byte-preserving inputs keep binary differences visible. Worker windows bound in-flight parsing; cross-file candidate retention and individual oversized files still affect memory.

Install from the current checkout with `cargo install --path apps/cli --locked`. After native publication, `cargo install differens --locked` installs the registry package. Existing historical JavaScript packages use different library APIs.
