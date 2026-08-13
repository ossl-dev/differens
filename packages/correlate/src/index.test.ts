import { describe, expect, it } from "bun:test";
import { createNode } from "@ossl-dev/differens-core";
import type { EditAction } from "@ossl-dev/differens-core";
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

describe("correlate: modified and value-based moves", () => {
  it("matches a value-identical renamed file as an exact move", () => {
    // A renamed file carries its path in the label, so its contentHash
    // differs even though not one byte of content changed. Equal values
    // count as exact.
    const oldFile = createNode({
      kind: "file",
      label: "old.ts",
      value: "export const x = 1;",
      byteRange: [0, 1],
    });
    const newFile = createNode({
      kind: "file",
      label: "new.ts",
      value: "export const x = 1;",
      byteRange: [0, 1],
    });
    expect(oldFile.contentHash).not.toBe(newFile.contentHash);

    const result = correlate([
      { filePath: "old.ts", actions: [{ type: "Delete", context: [], node: oldFile }] },
      {
        filePath: "new.ts",
        actions: [
          {
            type: "Insert",
            context: [],
            node: newFile,
            parent: createNode({ kind: "tree", byteRange: [0, 1] }),
            position: 0,
          },
        ],
      },
    ]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.fromFile).toBe("old.ts");
    expect(result.moves[0]!.toFile).toBe("new.ts");
    expect(result.moves[0]!.modified).toBe(false);
    expect(result.moves[0]!.similarity).toBe(1);
  });

  it("reports a similar-but-edited move as modified", () => {
    const mk = (label: string, body: string) =>
      createNode({
        kind: "Function",
        label,
        value: body,
        byteRange: [0, 1],
        children: [createNode({ kind: "Block", value: body, byteRange: [0, 1] })],
      });
    const delNode = mk("validate", "const a = 1; return check(a, input);");
    const insNode = mk("validate", "const a = 1; return check(a, input, opts);");

    const result = correlate([
      { filePath: "utils.ts", actions: [{ type: "Delete", context: [], node: delNode }] },
      {
        filePath: "validators.ts",
        actions: [
          {
            type: "Insert",
            context: [],
            node: insNode,
            parent: createNode({ kind: "file", byteRange: [0, 1] }),
            position: 0,
          },
        ],
      },
    ]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.modified).toBe(true);
    expect(result.moves[0]!.similarity).toBeGreaterThanOrEqual(0.6);
    expect(result.moves[0]!.similarity).toBeLessThan(1);
  });

  it("respects the renameSimilarityThreshold option", () => {
    const mk = (value: string) =>
      createNode({ kind: "Function", label: "f", value, byteRange: [0, 1] });
    const delNode = mk("alpha beta gamma");
    const insNode = mk("delta epsilon zeta");

    const strict = correlate(
      [
        { filePath: "a.ts", actions: [{ type: "Delete", context: [], node: delNode }] },
        {
          filePath: "b.ts",
          actions: [
            {
              type: "Insert",
              context: [],
              node: insNode,
              parent: createNode({ kind: "file", byteRange: [0, 1] }),
              position: 0,
            },
          ],
        },
      ],
      { renameSimilarityThreshold: 0.95 },
    );
    expect(strict.moves).toHaveLength(0);

    const loose = correlate(
      [
        { filePath: "a.ts", actions: [{ type: "Delete", context: [], node: delNode }] },
        {
          filePath: "b.ts",
          actions: [
            {
              type: "Insert",
              context: [],
              node: insNode,
              parent: createNode({ kind: "file", byteRange: [0, 1] }),
              position: 0,
            },
          ],
        },
      ],
      { renameSimilarityThreshold: 0.01 },
    );
    expect(loose.moves).toHaveLength(1);
  });

  it("consumes each deletion and insertion at most once", () => {
    const node = () => createNode({ kind: "Function", label: "f", byteRange: [0, 1] });
    const result = correlate([
      { filePath: "a.ts", actions: [{ type: "Delete", context: [], node: node() }] },
      {
        filePath: "b.ts",
        actions: [
          {
            type: "Insert",
            context: [],
            node: node(),
            parent: createNode({ kind: "file", byteRange: [0, 1] }),
            position: 0,
          },
          {
            type: "Insert",
            context: [],
            node: node(),
            parent: createNode({ kind: "file", byteRange: [0, 1] }),
            position: 1,
          },
        ],
      },
    ]);
    expect(result.moves).toHaveLength(1);
  });

  it("ignores unnamed nodes and different structures", () => {
    const unnamed = createNode({ kind: "Block", byteRange: [0, 1] });
    const named = createNode({ kind: "Function", label: "f", byteRange: [0, 1] });
    const result = correlate([
      { filePath: "a.ts", actions: [{ type: "Delete", context: [], node: unnamed }] },
      {
        filePath: "b.ts",
        actions: [
          {
            type: "Insert",
            context: [],
            node: named,
            parent: createNode({ kind: "file", byteRange: [0, 1] }),
            position: 0,
          },
        ],
      },
    ]);
    expect(result.moves).toHaveLength(0);
  });
});
