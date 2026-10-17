# Machine outputs

Use JSON for individual actions, NDJSON for streaming file records, and LLM output
for a compact report with source lines. Markdown groups edits for a human reader.
The same inputs and configuration produce the same output order.

## JSON

Repository and directory comparisons return one object with `perFile` and
`crossFileMoves` arrays:

```bash
differens main..feature --format=json
```

This example shows selected entries from a report with a rename and a move.
Node metadata is shortened for readability; actual nodes also include ranges,
hashes, children, and other metadata.

```json
{
  "perFile": [
    {
      "description": "renamed function `computeTotal` to `calculateTotalAmount`",
      "filePath": "src/checkout.ts",
      "action": {
        "type": "Update",
        "node": { "kind": "Function", "label": "calculateTotalAmount", "line": 12 },
        "detail": { "kind": "Renamed", "from": "computeTotal", "to": "calculateTotalAmount" },
        "context": [{ "kind": "Class", "label": "Checkout" }]
      }
    }
  ],
  "crossFileMoves": [
    {
      "kind": "Function",
      "name": "formatPrice",
      "fromFile": "src/old/utils.ts",
      "toFile": "src/new/utils.ts",
      "modified": false
    }
  ]
}
```

Each `perFile` entry is a `SemanticChange`: a description, file path, and typed
`action`. Its `context` lists enclosing nodes, nearest ancestor first. The action
types are `Insert`, `Delete`, `Update`, and `Move`. Cross-file summaries identify
the declaration or file, its source and destination, and whether it changed during
the move. JSON retains the original per-file actions even when a human report
combines them into a move.

Standalone file comparisons return a `SemanticChange` array rather than an
envelope. They use the old input path as `filePath`. Repository and directory
reports use the new path, or the old path for a deleted file. Those reports also
serialize update/move nodes and insertion parents with shallow metadata; additions
and deletions keep their subtrees. Standalone file actions retain full nodes.

An unchanged standalone comparison returns `[]`. An unchanged repository or
directory comparison returns `{"perFile":[],"crossFileMoves":[]}`.

### A complete standalone example

Save `{"retries":3}` as `before.json` and `{"retries":5}` as `after.json`, then run:

```bash
differens before.json after.json --format=json
```

```json
[
  {
    "action": {
      "type": "Update",
      "node": {"kind":"leaf","label":"retries","value":"5","scalarType":"number","byteRange":[0,1],"height":1,"contentHash":4110650987891553,"structureHash":1347011982717991,"children":[]},
      "detail": {
        "kind": "ValueChanged",
        "from": "3",
        "to": "5"
      },
      "context": [
        {
          "kind": "object",
          "label": "root"
        }
      ]
    },
    "filePath": "before.json",
    "description": "changed value of leaf `retries` from `3` to `5` in object `root`"
  }
]
```

This is the actual standalone shape, including node metadata. The `context`
places `retries` inside the root object. Directory/repository mode wraps such
changes in `perFile` and can add cross-file summaries.

### Fallback diagnostics

If semantic analysis falls back to lines, the CLI writes a note to stderr.
Repository/directory JSON also includes a `fallbacks` array of records with
`filePath` and `fallback`. NDJSON includes `fallback` on the affected file record.
Standalone JSON keeps its array shape, so its fallback note is on stderr only.
See [troubleshooting](/guides/troubleshooting.html) for common causes.

## LLM

`--format=llm` groups edits under named declarations and includes source lines
where the parser provides them. Unnamed edits, such as comments, appear as a
tally. The [quickstart](/getting-started/quickstart.html) produces:

```text
differens/1 1 files 5 changes 3 named
# before.ts
~ function calculateTotalAmount :3 computeTotal -> calculateTotalAmount
~ modified function computeTotal (1 removal) :4
~ modified function calculateTotalAmount (3 additions) :5
```

The header's `changes` count records the underlying actions before presentation
grouping, with each cross-file move counted once. `named` counts the presented
major entries and cross-file moves. These counts can differ from each other and
from the number of body lines. Both endpoints of a cross-file move contribute to
the file count.

| Part | Meaning |
| --- | --- |
| `differens/1 <files> files <changes> changes <named> named` | Report header; `/1` identifies the LLM text format |
| `# <path>` | File heading |
| `+` `-` `~` `>` | Insert, delete, update, move |
| `:12` | One-based source line, when available |
| `< class Checkout` | Nearest named ancestor scope |
| `from -> to` | Rename or value change |
| `~ modified function name (...) :12` | Grouped declaration edits |
| `* 2 comments` | Tally of minor edits |
| `# cross-file` | Start of cross-file move entries |
| `> name from -> to edited` | Modified cross-file move; exact moves omit `edited` |

Updates and insertions use new-source locations; deletions use old-source
locations. Grouped edits refer to their enclosing declaration. A structural body
replacement still names its function or method, and Go methods include their
receiver, for example `basicWriter.Write`.

You can pass the report to a model through a separate tool:

```bash
differens main..feature --format=llm | llm "summarize this changeset"
```

The `llm` command in this example is an external tool. Differens itself runs the
matching and narration locally without a model.

For the modified function move in the
[cross-file walkthrough](/how-it-works/cross-file-correlation.html#try-an-exact-move),
`differens old/ new/ --format=llm` prints:

```text
differens/1 2 files 1 changes 1 named
# cross-file
> formatPrice src/utils.ts -> src/pricing.ts edited
```

Here the body contains only a cross-file entry. Both endpoints still contribute
to the header's file count.

## Markdown

`--format=markdown` uses file headings and bullets, with related edits grouped
under their declaration. The quickstart produces:

```markdown
## before.ts

- renamed function `computeTotal` to `calculateTotalAmount`
- modified function `computeTotal` (1 removal)
- modified function `calculateTotalAmount` (3 additions)
```

Embedded backticks in source values use longer Markdown code delimiters.
Standalone comparisons with no logical changes render as `_no logical changes_`.
Empty repository or range comparisons use a context message, such as
`nothing changed` or `nothing changed in range: HEAD..HEAD`.

## NDJSON

`--format=ndjson` writes one JSON object per changed file, in input order, as each
bounded worker window completes. Each object has a `filePath` and a `changes`
array containing descriptions and actions. The path appears once on the file
record. Unchanged files produce no record, so an unchanged comparison produces
no stdout bytes.

To inspect file paths without loading one large JSON document:

```bash
differens main..feature --format=ndjson | jq -c 'select(.filePath) | .filePath'
```

Cross-file correlation needs the whole changeset. If it finds moves, one final
object contains their summaries:

```json
{"crossFileMoves":[{"kind":"Function","name":"formatPrice","fromFile":"src/old/utils.ts","toFile":"src/new/utils.ts","modified":false}]}
```

For the same two JSON files, `differens before.json after.json --format=ndjson`
prints one complete record:

```json
{"filePath":"before.json","changes":[{"description":"changed value of leaf `retries` from `3` to `5` in object `root`","action":{"type":"Update","node":{"kind":"leaf","label":"retries","value":"5","scalarType":"number","byteRange":[0,1],"height":1,"contentHash":4110650987891553,"structureHash":1347011982717991,"children":[]},"detail":{"kind":"ValueChanged","from":"3","to":"5"},"context":[{"kind":"object","label":"root"}]}}]}
```

Read file records with `select(.filePath)` and the trailer with
`select(.crossFileMoves)`. File actions have the same shape as JSON actions;
matching a cross-file move does not remove them from the stream.

The candidate cache holds 8 MiB before spilling to indexed temporary files.
Individual large files, temporary token sets, and the final move list can exceed
that cache budget. Streaming output does not guarantee constant memory use.

## Source coordinates

Rust `Node::byte_range` uses UTF-8 byte offsets. Serialized code-node `byteRange`
fields keep UTF-16 code-unit offsets for compatibility with earlier releases,
despite the field name. Tree-level source mapping converts code spans during
serialization, including emoji and combining text. Data adapters use synthetic
tree ranges, so those ranges cannot locate a scalar in its source file.

Lines are one-based when present. Hashes serialize as integers within the 53-bit
range. JSON has no separate schema-version field; the `differens/1` prefix applies
to the LLM text format.
