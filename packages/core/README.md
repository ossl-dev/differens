# @ossl-dev/differens-core

The matching engine behind [differens](https://github.com/ossl-dev/differens): give it two trees, get back what changed as typed actions rather than as lines.

No dependencies, no parser, no opinion about where the trees came from. If you can shape your data into a `Node`, you can diff it.

```bash
npm install @ossl-dev/differens-core
```

## Diffing a value

```ts
import { diffTrees, treeFromValue } from "@ossl-dev/differens-core";

const before = treeFromValue({ retries: 3, host: "a.example" });
const after = treeFromValue({ retries: 5, host: "a.example" });

diffTrees(before, after).changes;
// [{ type: "Update",
//    node: { kind: "leaf", label: "retries", ... },
//    detail: { kind: "ValueChanged", from: "3", to: "5" } }]
```

`host` is untouched, so it produces nothing. That is the whole point: the output is proportional to what changed, not to how much text moved.

## Diffing your own tree

Build nodes with `createNode` and the matcher takes it from there.

```ts
import { createNode, diffTrees } from "@ossl-dev/differens-core";

const fn = (name: string, body: string) =>
  createNode({
    kind: "Function",
    label: name,
    children: [createNode({ kind: "Body", value: body, byteRange: [0, body.length] })],
    byteRange: [0, 0],
  });

const before = createNode({ kind: "file", children: [fn("parse", "…")], byteRange: [0, 0] });
const after = createNode({ kind: "file", children: [fn("load", "…")], byteRange: [0, 0] });

diffTrees(before, after).changes;
// [{ type: "Update", detail: { kind: "Renamed", from: "parse", to: "load" } }]
```

`kind` groups nodes that are allowed to match each other. `label` is the name a
human would use. `value` is leaf content. Anything with the same `kind` and
identical children is recognised as unchanged wherever it ends up in the tree,
which is what turns a relocation into one `Move` instead of a delete and an add.

## What comes back

```ts
interface DiffResult {
  changes: EditAction[];
  /** Set when the trees were too large to match and the caller should line-diff */
  fallback?: "lines";
  nodeCount: number;
}
```

`EditAction` is a discriminated union on `type`:

| Type | Carries |
|---|---|
| `Insert` | the node, its `parent`, its `position` |
| `Delete` | the node |
| `Update` | the node and a `detail` of `Renamed` or `ValueChanged` |
| `Move` | the node, `fromParent`, `toParent`, `toPosition` |

Every action also carries `context`, the chain of enclosing named nodes, so a
change can be reported as "in class `RetryPolicy`" without a second traversal.

`fallback: "lines"` only appears when the caller sets `maxNodes` and one of
the trees exceeds it. The default is `Infinity`: every tree size is matched
for real. Treat an explicit `fallback` as "diff this some other way" rather
than as "no changes" -- an empty `changes` array means both things otherwise.

```ts
diffTrees(before, after, { minHeight: 2, bottomUpRatio: 0.5 });
```

## How it matches

Two passes, in the GumTree lineage (Falleri et al., ASE 2014):

1. **Top-down.** Identical subtrees are found by content hash, tallest first, and matched whole. A function that moved to another file is the same subtree, so it matches before anything else gets a chance to guess.
2. **Bottom-up.** Remaining containers match when enough of their descendants already did, by Dice coefficient. This is what survives a body edit: the function still matches even though its insides changed.

The tree is indexed in postorder, so a subtree is a contiguous id range and
"is X inside Y" is an integer comparison. Matching state lives in flat
`Int32Array`s rather than maps. Moves are reduced to a minimum by taking the
longest increasing subsequence of matched positions -- reordering three items
out of fifty reports three moves, not fifty.

Deterministic throughout: same inputs, same output, no model anywhere.

## Related

- [`@ossl-dev/differens-tiers`](https://www.npmjs.com/package/@ossl-dev/differens-tiers) -- parses source, config and markup into trees for this package
- [`@ossl-dev/differens-narrate`](https://www.npmjs.com/package/@ossl-dev/differens-narrate) -- turns these actions into sentences
- [`differens`](https://www.npmjs.com/package/differens) -- the CLI

MIT. [Source](https://github.com/ossl-dev/differens).
