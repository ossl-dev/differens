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
  return { type: "Delete", node };
}

function makeInsert(name: string): EditAction {
  const node = createNode({
    kind: "Function",
    label: name,
    byteRange: [0, name.length],
  });
  return {
    type: "Insert",
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
        actions: [{ type: "Delete", node: nodeA }],
      },
      {
        filePath: "src/b.ts",
        actions: [{
          type: "Insert",
          node: nodeB,
          parent: createNode({ kind: "file", byteRange: [0, 10] }),
          position: 0,
        }],
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
          { type: "Delete", node: nodeA },
          {
            type: "Insert",
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

  it("leaves unmatched as genuine deletes/inserts", () => {
    const nodeA = createNode({ kind: "Function", label: "foo", byteRange: [0, 10] });

    const fileChanges: FileChanges[] = [
      {
        filePath: "src/a.ts",
        actions: [{ type: "Delete", node: nodeA }],
      },
    ];

    const result = correlate(fileChanges);
    expect(result.moves).toHaveLength(0);
    expect(result.genuineDeletes).toHaveLength(1);
  });

  it("handles empty changeset", () => {
    const result = correlate([]);
    expect(result.moves).toHaveLength(0);
    expect(result.genuineDeletes).toHaveLength(0);
    expect(result.genuineInserts).toHaveLength(0);
  });
});
