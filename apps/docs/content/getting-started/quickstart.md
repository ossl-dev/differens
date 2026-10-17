# Quickstart

Create two files and compare their semantic changes. Install the native CLI first, or run it from a Cargo checkout.

## Step 1: Create two files

Create `before.ts` and `after.ts`. The example function is renamed and gains a parameter:

```typescript
// before.ts
export function computeTotal(items: Item[]): number {
  return items.reduce((acc, item) => acc + item.price, 0);
}

export const TAX_RATE = 0.08;
```

```typescript
// after.ts
export function calculateTotalAmount(items: Item[], discount: number): number {
  const base = items.reduce((acc, item) => acc + item.price, 0);
  return base - discount;
}

export const TAX_RATE = 0.08;
```

## Step 2: Run the diff

```bash Terminal
differens before.ts after.ts
```
```bash From a source checkout
cargo run -p differens -- before.ts after.ts
```

## Step 3: Read the output

```text
  ~ renamed function `computeTotal` to `calculateTotalAmount`
  - removed return from function `computeTotal`
  + added return in function `calculateTotalAmount`
  + added variable `base` in function `calculateTotalAmount`
  + added required param in function `calculateTotalAmount`
```

Each line is a typed edit action prefixed with an icon: `~` update, `+` insert, `-` delete. The function rename is one action, not a delete and an insert.

Compare that to a line diff of the same change:

```diff
- export function computeTotal(items: Item[]): number {
-   return items.reduce((acc, item) => acc + item.price, 0);
+ export function calculateTotalAmount(items: Item[], discount: number): number {
+   const base = items.reduce((acc, item) => acc + item.price, 0);
+   return base - discount;
  }
```

The line diff says the whole function was deleted and rewritten. Differens says: the function was renamed, a parameter was added, a variable was added, and the return was replaced.

**Info.**
Nodes that did not change (like `TAX_RATE`) produce no output. The diff core only emits actions for nodes that differ between the two trees.

## Step 4: Try JSON output

Pass `--format=json` for machine-readable output:

```bash Command
differens before.ts after.ts --format=json
```
```json Output
[
  {
    "type": "Update",
    "node": { "kind": "Function", "label": "calculateTotalAmount" },
    "detail": { "kind": "Renamed", "from": "computeTotal", "to": "calculateTotalAmount" },
    "context": [
      { "kind": "Export", "label": "" },
      { "kind": "file", "label": "" }
    ]
  },
  {
    "type": "Delete",
    "node": { "kind": "Return", "label": "" },
    "context": [
      { "kind": "Block", "label": "" },
      { "kind": "Function", "label": "computeTotal" }
    ]
  },
  {
    "type": "Insert",
    "node": { "kind": "Return", "label": "" },
    "context": [
      { "kind": "Block", "label": "" },
      { "kind": "Function", "label": "calculateTotalAmount" }
    ]
  }
]
```

Each entry is one typed edit action: `Insert`, `Delete`, `Update`, or `Move`. The `context` field gives the containment chain (nearest ancestor first) so you can reconstruct where every change happened. See [Machine Outputs](/guides/machine-outputs.html) for the full schema and the compact `--format=llm` mode.

## Step 5: Diff a git working tree

Run `differens` with no arguments inside a git repository. It diffs the working tree against `HEAD`:

```bash Command
cd your-project
differens
```
```text Output (excerpt)
src/utils.ts
  ~ renamed function `computeTotal` to `calculateTotalAmount`
  + added variable `timeout` in module `utils`

src/app.ts
  ~ changed value of port from `3000` to `8080`

  cross-file moves:
  → function `formatPrice` from src/old/utils.ts to src/new/utils.ts

3 modifications, 1 move
```

You can also diff a commit range:

```bash
differens main..feature
```

Or two specific commits:

```bash
differens 8f3a1c2 5b0e9d7
```

## Step 6: Diff two directories

Compare two directories. Files present in both are diffed; files only on one side show as additions or removals:

```bash Command
differens old/ new/
```
```text Output (excerpt)
src/utils.ts
  ~ renamed function `parseConfig` to `loadConfig`

src/models.ts
  ~ renamed interface `CartItem` to `LineItem`

  cross-file moves:
  → renamed file src/helpers/math.ts to src/utils/math.ts

146 modifications, 1 move
```

## What's next

- [CLI reference](/reference/cli.html): every command, flag, and format
- [Guides](/guides/git-integration.html): git integration, machine outputs, and benchmarks
- [How it works](/how-it-works/architecture.html): the matching algorithm, tier pipeline, and cross-file correlation
