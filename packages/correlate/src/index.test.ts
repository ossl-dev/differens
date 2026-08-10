import { describe, expect, it } from "bun:test";
import { createNode } from "@differens/core";
import type { EditAction } from "@differens/core";
import { correlate } from "./index";
import type { FileChanges } from "./index";

function makeFunc(name: string): EditAction {
  const node = createNode({
    kind: "Function",
    label: name,
    byteRange: [0, name.length],
  });
  return { type: "Delete", context: [], node };
}

function makeInsert(name: string): EditAction {
  const node = createNode({
    kind: "Function",
    label: name,
    byteRange: [0, name.length],
  });
  return {
    type: "Insert",
    context: [],
    node,
    parent: createNode({ kind: "file", byteRange: [0, 10] }),
    position: 0,
  };
}

describe("correlate", () => {
  it("detects exact content match across files", () => {
    const nodeA = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });
    const nodeB = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });
    // Force same hashes since content is identical
    expect(nodeA.contentHash).toBe(nodeB.contentHash);

    const fileChanges: FileChanges[] = [
      {
        filePath: "src/a.ts",
        actions: [{ type: "Delete", context: [], node: nodeA }],
      },
      {
        filePath: "src/b.ts",
        actions: [
          {
            type: "Insert",
            context: [],
            node: nodeB,
            parent: createNode({ kind: "file", byteRange: [0, 10] }),
            position: 0,
          },
        ],
      },
    ];

    const result = correlate(fileChanges);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.fromFile).toBe("src/a.ts");
    expect(result.moves[0]!.toFile).toBe("src/b.ts");
    expect(result.moves[0]!.modified).toBe(false);
  });

  it("skips same-file moves (already handled by core)", () => {
    const nodeA = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });
    const nodeB = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });

    const fileChanges: FileChanges[] = [
      {
        filePath: "src/a.ts",
        actions: [
          { type: "Delete", context: [], node: nodeA },
          {
            type: "Insert",
            context: [],
            node: nodeB,
            parent: createNode({ kind: "file", byteRange: [0, 10] }),
            position: 0,
          },
        ],
      },
    ];

    const result = correlate(fileChanges);
    // Same file, so no cross-file move
    expect(result.moves.filter((m) => m.fromFile !== m.toFile)).toHaveLength(0);
  });

  it("reports no move for a deletion with nothing to pair against", () => {
    const nodeA = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });

    const result = correlate([
      { filePath: "src/a.ts", actions: [{ type: "Delete", context: [], node: nodeA }] },
    ]);
    expect(result.moves).toHaveLength(0);
  });

  it("handles empty changeset", () => {
    expect(correlate([]).moves).toHaveLength(0);
  });
});
