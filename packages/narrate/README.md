# @ossl-dev/differens-narrate

Turns the edit script from [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) into something a person, or a model, can read.

Part of [differens](https://github.com/ossl-dev/differens). Template-based and deterministic: no model runs here either.

```bash
npm install @ossl-dev/differens-narrate
```

## Sentences

```ts
import { narrate, formatChanges, summarize } from "@ossl-dev/differens-narrate";

const changes = narrate(editActions, { filePath: "src/app.ts" });

changes[0].description;
// "renamed function `parseConfig` to `loadConfig`"

summarize(changes);
// "2 additions, 1 modification"
```

Each entry keeps its original action, so you can render the sentence and still
branch on `change.action.type`.

Narration reads the enclosing scope an action carries, which is where phrases
like "removed function `retry` from class `RetryPolicy`" come from. Anonymous
nodes are introduced by a glimpse of their source rather than as "unnamed",
which on a real file was most of the output.

Repeated edits collapse. Renaming a symbol used five times changes five nodes
but reports one sentence, keyed on the from/to pair.

## Four output formats

```ts
formatChanges(changes, { format: "terminal" }); // default, one line per change
formatChanges(changes, { format: "markdown" }); // grouped under file headings
formatChanges(changes, { format: "json" });     // the raw SemanticChange array
formatChanges(changes, { format: "llm" });      // dense, for a model
```

## The `llm` format

Built to cost less than the diff it replaces. On a 14-file changeset it is
6.5KB where `git diff` is 100KB.

```
differens/1 3 files 380 changes 113 named
# apps/cli/src/index.ts
+ function runWorker :373
- function mapWithConcurrency :313
~ function report :141 handleGitDiff -> report
* 12 comments, 3 expressions
# config/app.json
~ leaf port :14 < object database 3000 -> 8080
```

One line per change, the file named once. `+ - ~ >` are added, removed,
changed, moved; `*` is a rolled-up count. `:N` is the source line and
`< Kind name` the enclosing scope.

Two things do the work. Changes that carry no name a reader could act on --
comments, prose lines, bare expressions -- collapse into a tally instead of
spending a line each. And every named change carries its line number, so a
model can read the twenty lines around a change rather than the whole file.

An earlier version of this format was pretty-printed JSON and cost *more* than
the raw diff: keys and the file path repeated per entry, empty fields still
emitted, one object per changed line of prose.

## Related

- [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) -- produces the actions this reads
- [`@ossl-dev/differens-tiers`](https://www.npmjs.com/package/@ossl-dev/differens-tiers) -- parses files into trees
- [`differens`](https://www.npmjs.com/package/differens) -- the CLI, which is this plus git

MIT. [Source](https://github.com/ossl-dev/differens).
