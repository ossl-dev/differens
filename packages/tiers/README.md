# @ossl-dev/differens-tiers

Turns a file into a tree that [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) can match, picking the parser from the path.

Part of [differens](https://github.com/ossl-dev/differens).

```bash
npm install @ossl-dev/differens-tiers
```

## Diffing two files

```ts
import { diffWithTier } from "@ossl-dev/differens-tiers";

const { changes, tier, nodeCount } = diffWithTier(
  oldSource,
  newSource,
  "src/app.ts",
  "src/app.ts",
);
```

The paths are how the tier is chosen, so pass the real ones even when the bytes
came from somewhere else -- a git blob, a temp file, a buffer. Handing it the
name of a scratch file with no extension gets you a line diff of TypeScript.

## The ladder

Six tiers, each falling back to the one below when it cannot parse:

| Tier | Handles | Produces |
|---|---|---|
| **Code** | ts, tsx, js, py, rs, go, and ~25 more by extension | tree-sitter CST, with semantic labels for TS/JS, Python, Rust and Go |
| **Data** | json, jsonc, yaml, yml, toml, ini | value trees, so `database.pool.max` is one changed leaf |
| **Markup** | html, xml, svg, plist | element trees keyed on `id`/`class` |
| **Prose** | txt, log, LICENSE, README | word-level diff |
| **Raw** | everything else, and markdown | LCS line diff |
| **Binary** | by extension, or sniffed from NUL bytes | size comparison only |

A tier is used only if it both parses *and* returns a usable tree diff, so an
oversized file does not report "no changes" -- it falls through to the line
diff that can actually answer.

## Which files are worth parsing

```ts
import { isParseable, hasGrammar, classifyFile } from "@ossl-dev/differens-tiers";

isParseable("src/app.ts");   // true  -- a real tree comes out
isParseable("notes.md");     // false -- line diff either way
hasGrammar("rs");            // is the Rust grammar installed
classifyFile("config.yaml"); // { path, extension: "yaml", tier: Tier.Data }
```

`isParseable` is the one worth reaching for before you spend money on a file.
Parsing dominates the cost of a diff, so a changeset of files that will only
ever be line-diffed is not worth handing to a worker pool -- it finishes sooner
inline than the workers take to start.

## Grammars

The tree-sitter grammars are native addons, loaded synchronously the first time
an extension is seen. Diffing a Python changeset never pays for the Rust and Go
grammars.

They cannot be embedded in a single-file compiled executable. In one, this
package falls back to line diff unless it is run somewhere the grammars are
installed.

## Also exported

`parseCode(source, extension)` and `parseData(source)` return a `Node` tree
directly, if you want the tree without the diff. `treeFromValue(value)` builds
one from an in-memory object. `getExtractors()` lists what has semantic support
versus generic CST node types.

## Related

- [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) -- the matching engine these trees feed
- [`@ossl-dev/differens-narrate`](https://www.npmjs.com/package/@ossl-dev/differens-narrate) -- turns the result into sentences
- [`differens`](https://www.npmjs.com/package/differens) -- the CLI

MIT. [Source](https://github.com/ossl-dev/differens).
