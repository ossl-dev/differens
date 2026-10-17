# Machine Outputs

Available report formats: `--format=json`, `--format=llm`, `--format=markdown`, and `--format=ndjson`. Output ordering is deterministic for the same inputs and configuration.

## JSON

`differens main..feature --format=json` prints one document with everything: the per-file narrated changes and the cross-file moves.

```json
{
  "perFile": [
    {
      "description": "renamed function `computeTotal` to `calculateTotalAmount`",
      "filePath": "src/checkout.ts",
      "action": {
        "type": "Update",
        "node": { "kind": "function", "label": "calculateTotalAmount", "line": 12 },
        "detail": { "kind": "Renamed", "from": "computeTotal", "to": "calculateTotalAmount" },
        "context": [{ "kind": "class", "label": "Checkout" }]
      }
    }
  ],
  "crossFileMoves": [
    {
      "kind": "function",
      "name": "formatPrice",
      "fromFile": "src/old/utils.ts",
      "toFile": "src/new/utils.ts",
      "modified": false
    }
  ]
}
```

Schema notes:

- In the legacy schema, code-node `byteRange` values retain UTF-16 code-unit offsets for compatibility. Native Rust `Node::byte_range` values use UTF-8 bytes; conversion happens only at serialization. Data adapters can use synthetic ranges, so those ranges are not guaranteed to locate the scalar in its original source text.

- `perFile` is an array of `SemanticChange` objects: `description`, `filePath`, and the typed `action` and containment `context` chain, nearest ancestor first. Update/move nodes and insertion parents use shallow metadata projections; added/deleted nodes retain subtrees.
- `crossFileMoves` is a flattened summary of kind, name, source, destination, and whether the node was edited in transit.
- Hash values are serialized as integers within the legacy 53-bit range.
- This envelope is for repository/directory comparisons. Standalone file JSON is a `SemanticChange` array.
- Empty file JSON is `[]`; an empty changeset is `{"perFile":[],"crossFileMoves":[]}`. NDJSON emits no file record for unchanged inputs.
- When semantic analysis falls back to lines, changeset JSON adds `fallbacks` records with `filePath` and `fallback`. NDJSON places fallback information on the affected file record.

## LLM

`--format=llm` is a compact, self-contained document. It costs less than the raw diff it replaces. Each named change gets one line, each file is named once, and unnamed churn collapses into a tally. Every named change carries its source line, so a model can read twenty lines of context instead of the whole file.

```text
differens/1 2 files 5 changes 4 named
# src/checkout.ts
~ function computeTotal :12 < class Checkout computeTotal -> calculateTotalAmount
+ function applyDiscount :40
# src/cart.ts
* 2 comments
# cross-file
> formatPrice src/old/utils.ts -> src/new/utils.ts edited
```

Line grammar:

| Part | Meaning |
| --- | --- |
| `differens/1 <files> files <changes> changes <named> named` | Header, one line |
| `# <path>` | File heading, named once |
| `+` `-` `~` `>` | Insert, Delete, Update, Move |
| `:12` | 1-based source line of the change |
| `< class Checkout` | Nearest named ancestor scope |
| `from -> to` | Rename or value change |
| `* 2 comments` | Rolled-up minor changes (unnamed nodes, prose lines) |
| `# cross-file` / `> name from -> to [edited]` | Cross-file moves section |

Pipe it straight into a model:

```bash Feed an LLM
differens main..feature --format=llm | llm "summarize this changeset"
```

```text Sample model answer
Renamed computeTotal to calculateTotalAmount inside Checkout, added
applyDiscount, and moved formatPrice from src/old/utils.ts to
src/new/utils.ts with minor edits.
```

## Markdown

`--format=markdown` is a changelog you can drop into a PR description: one `##` heading per file, one bullet per change.

```md
## src/checkout.ts

- renamed function `computeTotal` to `calculateTotalAmount`
- added function `applyDiscount`
```

Standalone comparisons with no logical changes render as `_no logical changes_`. Empty repository or range comparisons use their context message, such as `nothing changed` or `nothing changed in range: HEAD..HEAD`.

## NDJSON (streaming)

`--format=ndjson` is the streaming format: one JSON object per changed file, emitted in input order as bounded worker windows complete. A long changeset starts producing output while the later files are still matching.

```json
{"filePath":"src/checkout.ts","changes":[{"description":"renamed function `computeTotal` to `calculateTotalAmount`","action":{...}}]}
```

Per-line shape:

- `filePath`: which file this object covers.
- `changes`: narrated changes for that file, `description` plus the typed `action`, same shape as the `perFile` entries in the JSON format.
- Unchanged files produce no line, matching the other formats.

NDJSON streams file output. Cross-file candidates use an 8 MiB memory cache, then spill to indexed temporary storage. Individual large files, token sets during correlation, and the resulting move list can still exceed that cache budget.

Cross-file moves need the whole changeset, so when any exist they trail as one final object:

```json
{"crossFileMoves":[{"kind":"function","name":"formatPrice","fromFile":"src/old/utils.ts","toFile":"src/new/utils.ts","modified":false}]}
```

Consumers filter per-file lines with `select(.filePath)` and read the trailer with `select(.crossFileMoves)`.

```bash
differens main..feature --format=ndjson | jq -c 'select(.filePath) | .filePath'
```

## Source coordinates

Schema 1 code-node `byteRange` fields retain the legacy UTF-16 code-unit offsets, despite the historical field name. Rust `Node::byte_range` uses UTF-8 byte offsets. Tree-level source mapping translates serialized code spans, including emoji and combining text. Data adapters use synthetic tree ranges rather than source offsets. Lines are one-based.
