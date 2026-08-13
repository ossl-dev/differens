/**
 * Diff benchmark: parse + match + narrate on synthetic files of growing size,
 * plus a worst case (wide sibling list) and a reorder case.
 *
 * Run: bun run apps/cli/bench/bench.ts
 */

import { diffTrees } from "@ossl-dev/differens-core";
import { diffWithTier } from "@ossl-dev/differens-tiers";
import { parseCode } from "@ossl-dev/differens-tiers";

function genFile(fns: number, seed = 0): string {
  const out: string[] = [];
  for (let i = 0; i < fns; i++) {
    out.push(`
export function handler${i}(input: Request, ctx: Context${seed}): Result {
  const parsed = parseBody(input.body, { strict: true, limit: ${i + seed} });
  if (!parsed.ok) { return fail("bad request ${i}", parsed.error); }
  const rows = ctx.db.query("select * from t${i} where id = ?", [parsed.id]);
  return { status: 200, rows: rows.map((r) => ({ ...r, tag: "t${i}" })) };
}`);
  }
  return out.join("\n");
}

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(40)} ${ms.toFixed(1)} ms`);
  return r;
}

console.log("\n== parse + diff, one small edit ==");
for (const fns of [50, 200, 800]) {
  const oldSrc = genFile(fns);
  const newSrc = genFile(fns).replace("handler7(", "handleSeven(");
  const nodes = parseCode(oldSrc, "ts");
  const count = countNodes(nodes);
  const r = time(`${fns} functions (${count} nodes)`, () =>
    diffWithTier(oldSrc, newSrc, "a.ts", "a.ts"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== reorder: first function moved to the end ==");
{
  const oldSrc = genFile(200);
  const parts = genFile(200).split("\nexport function ");
  const newSrc = [parts[0], ...parts.slice(2), parts[1]].join("\nexport function ");
  const r = time("200 functions, one relocated", () =>
    diffWithTier(oldSrc, newSrc, "a.ts", "a.ts"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== worst case: nothing matches ==");
{
  const oldSrc = genFile(200, 1);
  const newSrc = genFile(200, 2);
  const r = time("200 functions, every line differs", () =>
    diffWithTier(oldSrc, newSrc, "a.ts", "a.ts"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== wide sibling list (10k flat children) ==");
{
  const wide = (n: number, changed = -1) => {
    const kids = [];
    for (let i = 0; i < n; i++) kids.push({ k: i === changed ? "x" : `k${i}` });
    return kids;
  };
  const { createNode } = require("@ossl-dev/differens-core");
  const build = (kids: { k: string }[]) =>
    createNode({
      kind: "root",
      byteRange: [0, 0],
      children: kids.map((c) => createNode({ kind: "leaf", label: c.k, byteRange: [0, 1] })),
    });
  const a = build(wide(10_000));
  const b = build(wide(10_000, 5000));
  const r = time("10k siblings, one changed", () => diffTrees(a, b));
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== large raw file (100k lines), one line edit ==");
{
  const lines: string[] = [];
  for (let i = 0; i < 100_000; i++) lines.push(`line ${i} some content here`);
  const oldSrc = lines.join("\n");
  const newSrc = lines.toSpliced(50_000, 1, "line 50000 EDITED content here").join("\n");
  const r = time("100k-line file, one edit (raw tier)", () =>
    diffWithTier(oldSrc, newSrc, "a.md", "a.md"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== large prose document (60k words), one word edit ==");
{
  const words: string[] = [];
  for (let i = 0; i < 60_000; i++) words.push(`word${i}`);
  const oldSrc = words.join(" ");
  const newSrc = words.toSpliced(30_000, 1, "changed").join(" ");
  const r = time("60k-word document, one edit (prose tier)", () =>
    diffWithTier(oldSrc, newSrc, "a.txt", "a.txt"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== rewritten large file (20k lines, nothing shared) ==");
{
  const a: string[] = [];
  const b: string[] = [];
  for (let i = 0; i < 20_000; i++) a.push(`aaa ${i}`);
  for (let i = 0; i < 20_000; i++) b.push(`bbb ${i}`);
  const r = time("20k-line file, fully rewritten", () =>
    diffWithTier(a.join("\n"), b.join("\n"), "a.md", "a.md"),
  );
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== deep chain (200k nodes) ==");
{
  const { createNode } = require("@ossl-dev/differens-core");
  const chain = (depth: number) => {
    let n = createNode({ kind: "leaf", label: "x", byteRange: [0, 0] });
    for (let i = 0; i < depth; i++)
      n = createNode({ kind: "node", byteRange: [0, 0], children: [n] });
    return n;
  };
  const a = chain(200_000);
  const b = chain(200_000);
  const r = time("200k-node deep chain, full match", () => diffTrees(a, b));
  console.log(`  ${" ".repeat(40)} -> ${r.changes.length} changes`);
}

console.log("\n== 3 MiB text file, one edit ==");
{
  const chunk = "const value = 42; // padded line for a big generated file\n".repeat(2048);
  const big = chunk.repeat(48); // ~3 MiB
  const t0 = performance.now();
  const r = diffWithTier(big, big.replace("const value = 42", "const value = 43"), "a.md", "a.md");
  const ms = performance.now() - t0;
  console.log(
    `  3 MiB file, one edit ${" ".repeat(15)} ${ms.toFixed(1)} ms -> ${r.changes.length} changes`,
  );
}

function countNodes(n: { children: unknown[] }): number {
  let c = 0;
  const stack = [n];
  while (stack.length) {
    const x = stack.pop()! as { children: { children: unknown[] }[] };
    c++;
    for (const k of x.children) stack.push(k);
  }
  return c;
}
