# @ossl-dev/differens-correlate

Finds the code that moved between files.

Part of [differens](https://github.com/ossl-dev/differens). A per-file diff cannot see this: extracting a function into a new module looks like a deletion in one file and an unrelated addition in another, and no amount of looking at either file alone will connect them.

```bash
npm install @ossl-dev/differens-correlate
```

## Use

Run your per-file diffs first, then hand the whole set over at once.

```ts
import { correlate } from "@ossl-dev/differens-correlate";

const { moves } = correlate([
  { filePath: "src/utils.ts", actions: utilsActions },
  { filePath: "src/validators.ts", actions: validatorsActions },
]);

moves[0];
// { node:       { kind: "Function", label: "validate", ... },
//   fromFile:   "src/utils.ts",
//   toFile:     "src/validators.ts",
//   modified:   false,
//   similarity: 1 }
```

`modified` says whether the code changed on the way. A clean relocation is
`false` with `similarity: 1`; something that was moved *and* edited comes back
`true` with a score below it, which is the difference between "this moved" and
"this moved and you should read it again".

```ts
correlate(fileChanges, { renameSimilarityThreshold: 0.75 }); // default 0.6
```

## How it decides

Deleted and inserted nodes are bucketed by structure hash, so only things
shaped alike are ever compared. Within a bucket, an identical content hash or
an identical value is an unambiguous move. Anything short of that is scored,
and only clears the bar above the threshold.

Only *named* nodes are considered. Correlating anonymous ones produced
confident nonsense: two unrelated files that happened to share a directory name
in their paths would report their contents as having moved between them.

## Related

- [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) -- produces the per-file actions this reads
- [`@ossl-dev/differens-narrate`](https://www.npmjs.com/package/@ossl-dev/differens-narrate) -- turns a move into "moved function `validate` from utils.ts to validators.ts"
- [`differens`](https://www.npmjs.com/package/differens) -- the CLI, which runs this across a whole changeset

MIT. [Source](https://github.com/ossl-dev/differens).
