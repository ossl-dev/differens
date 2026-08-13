/**
 * Known-refactor scenarios through the full tier pipeline. Each case pins
 * the shape of the report a reviewer would expect for one classic refactor.
 */
import { describe, expect, it } from "bun:test";
import { Tier, diffWithTier } from "./index";

function changesOf(oldSource: string, newSource: string, path = "a.ts") {
  const result = diffWithTier(oldSource, newSource, path, path);
  return { result, changes: result.changes };
}

describe("extract method", () => {
  const oldSource = `function process(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  return upper + "!";
}
`;
  const newSource = `function process(input: string): string {
  const trimmed = input.trim();
  return shout(trimmed);
}

function shout(s: string): string {
  const upper = s.toUpperCase();
  return upper + "!";
}
`;

  it("reports the extracted helper as an insert and keeps the original", () => {
    const { result, changes } = changesOf(oldSource, newSource);
    expect(result.tier).toBe(Tier.Code);

    const inserted = changes.filter((c) => c.type === "Insert");
    expect(inserted.length).toBeGreaterThanOrEqual(1);
    expect(inserted.some((c) => c.node.kind === "Function" && c.node.label === "shout")).toBe(true);

    const deletes = changes.filter((c) => c.type === "Delete");
    expect(deletes.some((c) => c.node.kind === "Function" && c.node.label === "process")).toBe(
      false,
    );
  });
});

describe("rename with call site", () => {
  const oldSource = `function compute(a: number): number { return a * 2; }
export const total = compute(21);
`;
  const newSource = `function doubleUp(a: number): number { return a * 2; }
export const total = doubleUp(21);
`;

  it("reports the rename and the call site change, not a delete", () => {
    const { result, changes } = changesOf(oldSource, newSource);
    expect(result.tier).toBe(Tier.Code);

    const renames = changes.filter(
      (c) => c.type === "Update" && c.detail.kind === "Renamed" && c.detail.from === "compute",
    );
    expect(renames.length).toBeGreaterThanOrEqual(1);

    expect(
      changes.some(
        (c) => c.type === "Delete" && c.node.kind === "Function" && c.node.label === "compute",
      ),
    ).toBe(false);
  });
});

describe("reformat only", () => {
  const tight = "export function go(raw: string): string { return raw.trim(); }\n";
  const spaced = "export function go(raw: string): string {\n  return raw.trim();\n}\n";

  it("reports no logical changes for pure reformatting", () => {
    const { result, changes } = changesOf(tight, spaced);
    expect(result.tier).toBe(Tier.Code);
    expect(changes).toEqual([]);
  });
});

describe("config value change", () => {
  it("reports the exact key path in the context", () => {
    const { result, changes } = changesOf(
      '{"database": {"pool": {"max": 10}}}',
      '{"database": {"pool": {"max": 25}}}',
      "config.json",
    );
    expect(result.tier).toBe(Tier.Data);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("Update");
    if (changes[0]!.type === "Update") {
      expect(changes[0]!.detail.kind).toBe("ValueChanged");
      expect(changes[0]!.context.map((c) => c.label)).toEqual(["pool", "database", "root"]);
    }
  });
});

describe("comment churn", () => {
  const oldSource = "export const x = 1;\n";
  const newSource = "// explain the constant\nexport const x = 1;\n";

  it("reports only the comment change, nothing logical", () => {
    const { result, changes } = changesOf(oldSource, newSource);
    expect(result.tier).toBe(Tier.Code);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.node.kind === "Comment")).toBe(true);
  });
});

describe("paragraph move in prose", () => {
  const oldText = "First paragraph.\n\nSecond paragraph.\n";
  const newText = "Second paragraph.\n\nFirst paragraph.\n";

  it("reports the moved paragraph as a Move", () => {
    const { result, changes } = changesOf(oldText, newText, "note.txt");
    expect(result.tier).toBe(Tier.Prose);
    expect(changes.some((c) => c.type === "Move")).toBe(true);
  });
});
