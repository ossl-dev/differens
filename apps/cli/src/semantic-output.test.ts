import { describe, expect, it } from "bun:test";
import { formatChanges, narrate } from "@ossl-dev/differens-narrate";
import { Tier, diffWithTier } from "@ossl-dev/differens-tiers";

function diff(before: string, after: string, extension = "ts") {
  return diffWithTier(before, after, `app.${extension}`, `app.${extension}`);
}

describe("semantic output regressions", () => {
  it("reports a 3000-line addition once, without printing its body", () => {
    const source = Array.from({ length: 3000 }, (_, i) => `export const value${i} = ${i};`).join(
      "\n",
    );
    const result = diff("", source);
    expect(result.changes).toHaveLength(1);
    for (const format of ["terminal", "markdown", "llm"] as const) {
      const output = formatChanges(narrate(result.changes), { format });
      expect(output.length).toBeLessThan(100);
      expect(output).not.toContain("value2999");
    }
  });

  it("keeps two config changes with identical before/after values", () => {
    const changes = narrate(
      diff('{"port":1,"retries":1}', '{"port":2,"retries":2}', "json").changes,
    );
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.action.node.label).sort()).toEqual(["port", "retries"]);
  });

  it("keeps recursive call-site edits when a function is renamed", () => {
    const changes = narrate(
      diff("function before(){ return before(); }", "function after(){ return after(); }").changes,
    );
    expect(changes).toHaveLength(2);
    expect(changes.some((c) => c.action.node.kind === "Function")).toBe(true);
    expect(changes.some((c) => c.action.node.kind === "identifier")).toBe(true);
  });

  it.each([
    ["+", "-"],
    ["===", "!=="],
    ["&&", "||"],
    [">", ">="],
  ])("detects operator changes %s -> %s", (before, after) => {
    const result = diff(
      `function check(a,b){ return a ${before} b; }`,
      `function check(a,b){ return a ${after} b; }`,
    );
    const output = formatChanges(narrate(result.changes), { format: "terminal" });
    expect(output).toContain("function `check`");
    expect(output).toContain(`\`${before}\` → \`${after}\``);
    expect(output.split("\n")).toHaveLength(1);
  });

  it("detects keyword changes", () => {
    expect(diff("const value = 1;", "let value = 1;").changes.length).toBeGreaterThan(0);
  });

  it.each(["mts", "cts"])("parses %s as TypeScript", (extension) => {
    const result = diff(
      "export function run(){return 1}",
      "export function run(){return 2}",
      extension,
    );
    expect(result.tier).toBe(Tier.Code);
    expect(formatChanges(narrate(result.changes), { format: "terminal" })).toContain(
      "function `run`",
    );
  });

  it("does not call an existing file removed when its contents are rewritten", () => {
    const result = diff("function old(){return true}", "const other = [1,2,3]");
    expect(result.changes.some((c) => c.type === "Delete" && c.node.kind === "file")).toBe(false);
    const output = formatChanges(narrate(result.changes), { format: "terminal" });
    expect(output).toContain("removed function `old`");
    expect(output).toContain("added variable `other`");
  });

  it("distinguishes adding an empty file from emptying an existing one", () => {
    const added = diffWithTier("", "", "app.ts", "app.ts", { oldExists: false, newExists: true });
    expect(added.changes[0]!.type).toBe("Insert");
    const emptied = diffWithTier("function old(){}", "", "app.ts", "app.ts", {
      oldExists: true,
      newExists: true,
    });
    expect(emptied.changes.some((c) => c.node.kind === "file")).toBe(false);
  });

  it("groups local bindings with their function instead of listing each variable", () => {
    const source = (offset: number) =>
      `function run(){ ${Array.from(
        { length: 100 },
        (_, i) => `const local${i} = ${i + offset};`,
      ).join(" ")} }`;
    const output = formatChanges(narrate(diff("function run(){}", source(0)).changes), {
      format: "terminal",
    });
    expect(output).toContain("function `run`");
    expect(output).not.toContain("added variable `local");
    expect(output.split("\n").length).toBeLessThan(4);
  });

  it("summarizes a raw rewrite without printing every line", () => {
    const before = Array.from({ length: 100 }, (_, i) => `old-${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `new-${i}`).join("\n");
    const changes = narrate(diff(before, after, "md").changes);
    expect(changes.length).toBeGreaterThan(1);
    expect(formatChanges(changes, { format: "terminal" }).split("\n")).toHaveLength(1);
    expect(JSON.parse(formatChanges(changes, { format: "json" }))).toHaveLength(changes.length);
  });
});
