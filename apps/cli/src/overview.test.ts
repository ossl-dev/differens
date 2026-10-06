import { describe, expect, it } from "bun:test";
import { createNode } from "@ossl-dev/differens-core";
import type { SemanticChange } from "@ossl-dev/differens-core";
import { formatChanges, narrate, readableChanges } from "@ossl-dev/differens-narrate";
import { diffWithTier } from "@ossl-dev/differens-tiers";
import { overview } from "./overview";

function additions(count: number): SemanticChange[] {
  return Array.from({ length: count }, (_, i) => ({
    filePath: `services/backend/src/billing/file${i}.ts`,
    description: `added file services/backend/src/billing/file${i}.ts`,
    action: {
      type: "Insert" as const,
      node: createNode({ kind: "file", label: `file${i}.ts`, byteRange: [0, 0] }),
      parent: createNode({ kind: "file", byteRange: [0, 0] }),
      position: i,
      context: [],
    },
  }));
}

describe("large change overview", () => {
  it("reports every file in totals while keeping a thousand-file addition readable", () => {
    const output = overview(additions(1000), [], "terminal")!;
    expect(output).toContain("1000 files with logical changes: 1000 added");
    expect(output).toContain("services/backend/src/billing/");
    expect(output.split("\n").length).toBeLessThan(15);
    expect(output).toContain("Selected changes");
    expect(output).toContain("--all");
  });

  it("bounds a wide directory tree and includes all files in area totals", () => {
    const changes = additions(1000).map((change, i) => ({
      ...change,
      filePath: `area${i % 100}/sub${i % 20}/file${i}.ts`,
    }));
    const output = overview(changes, [], "terminal")!;
    expect(output.split("\n").length).toBeLessThan(70);
    const counts = [...output.matchAll(/— (\d+) added/g)].map((match) => Number(match[1]));
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(1000);
  });

  it("keeps small comparisons in the per-file format", () => {
    expect(overview(additions(3), [], "terminal")).toBeUndefined();
  });

  it("does not discard from/to details when already grouped changes are formatted", () => {
    const result = diffWithTier(
      "function check(a,b){ return a === b; }",
      "function check(a,b){ return a !== b; }",
      "app.ts",
      "app.ts",
    );
    const changes = narrate(result.changes);
    const grouped = readableChanges(changes);
    expect(formatChanges(grouped, { format: "terminal" })).toBe(
      formatChanges(changes, { format: "terminal" }),
    );
    expect(formatChanges(grouped, { format: "terminal" })).toContain("`===` → `!==`");
  });
});
