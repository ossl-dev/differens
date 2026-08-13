import { describe, expect, it } from "bun:test";
import { DEFAULT_OPTIONS } from "./actions";
import { generateEditScript } from "./edit-script";
import { diffTrees } from "./index";
import {
  Matching,
  bottomUpMatch,
  indexTree,
  recoverContainers,
  recoverLeaves,
  topDownMatch,
} from "./match";
import { createNode } from "./node";
import type { Node } from "./node";

function leaf(kind = "leaf", label?: string, value?: string): Node {
  return createNode({ kind, label, value, byteRange: [0, 1] });
}

function tree(kind: string, children: Node[], label?: string): Node {
  return createNode({ kind, label, children, byteRange: [0, 1] });
}

function matchPair(oldRoot: Node, newRoot: Node): Matching {
  const oldIdx = indexTree(oldRoot);
  const newIdx = indexTree(newRoot);
  const m = new Matching(oldIdx.n, newIdx.n);
  topDownMatch(oldIdx, newIdx, m, DEFAULT_OPTIONS);
  bottomUpMatch(oldIdx, newIdx, m, DEFAULT_OPTIONS);
  recoverLeaves(oldIdx, newIdx, m);
  recoverContainers(oldIdx, newIdx, m);
  recoverLeaves(oldIdx, newIdx, m);
  return m;
}

describe("generateEditScript: updates", () => {
  it("reports a rename together with the name leaf's value change", () => {
    const a = tree("fn", [leaf("name", "foo"), leaf("num", "1")], "foo");
    const b = tree("fn", [leaf("name", "bar"), leaf("num", "1")], "bar");
    const oldIdx = indexTree(a);
    const newIdx = indexTree(b);
    const changes = generateEditScript(oldIdx, newIdx, matchPair(a, b));

    // The fn relabels and its name leaf changes value; narration dedups the
    // pair, the raw script keeps both.
    const updates = changes.filter((c) => c.type === "Update");
    expect(updates).toHaveLength(2);
    const rename = updates.find((c) => c.type === "Update" && c.detail.kind === "Renamed");
    expect(rename).toBeDefined();
    if (rename!.type === "Update" && rename!.detail.kind === "Renamed") {
      expect(rename!.detail.from).toBe("foo");
      expect(rename!.detail.to).toBe("bar");
    }
  });

  it("reports a value change as a ValueChanged update", () => {
    const a = tree("root", [tree("assign", [leaf("num", undefined, "1")])]);
    const b = tree("root", [tree("assign", [leaf("num", undefined, "2")])]);
    const oldIdx = indexTree(a);
    const newIdx = indexTree(b);
    const changes = generateEditScript(oldIdx, newIdx, matchPair(a, b));

    const updates = changes.filter((c) => c.type === "Update");
    expect(updates).toHaveLength(1);
    if (updates[0]!.type === "Update") {
      expect(updates[0]!.detail.kind).toBe("ValueChanged");
      if (updates[0]!.detail.kind === "ValueChanged") {
        expect(updates[0]!.detail.from).toBe("1");
        expect(updates[0]!.detail.to).toBe("2");
      }
    }
  });

  it("reports a rename plus a value change on the same node", () => {
    const a = tree("fn", [leaf("name", "foo")], "foo");
    const b = tree("fn", [leaf("name", "bar")], "bar");
    const changes = diffTrees(a, b).changes;
    const updates = changes.filter((c) => c.type === "Update");
    expect(updates).toHaveLength(2);
  });
});

describe("generateEditScript: moves", () => {
  it("reports a relocated child as a Move", () => {
    const a = tree("root", [
      tree("fn", [leaf("body", "one")], "one"),
      tree("fn", [leaf("body", "two")], "two"),
    ]);
    const b = tree("root", [
      tree("fn", [leaf("body", "two")], "two"),
      tree("fn", [leaf("body", "one")], "one"),
    ]);
    const changes = diffTrees(a, b).changes;
    const moves = changes.filter((c) => c.type === "Move");
    expect(moves).toHaveLength(1);
    // One sibling stays in place (the LIS), the other is the move.
    if (moves[0]!.type === "Move") {
      expect(moves[0]!.node.label).toBe("one");
      expect(moves[0]!.fromPosition).toBe(0);
      expect(moves[0]!.toPosition).toBe(1);
    }
  });

  it("keeps the longest increasing subsequence and moves only the rest", () => {
    // c a b keeps a,b in relative order: only c moves.
    const fns = (order: number[]) =>
      tree(
        "root",
        order.map((i) => tree("fn", [leaf("body", `b${i}`)], `f${i}`)),
      );
    const a = fns([0, 1, 2]);
    const b = fns([2, 0, 1]);
    const changes = diffTrees(a, b).changes;
    const moves = changes.filter((c) => c.type === "Move");
    expect(moves).toHaveLength(1);
    if (moves[0]!.type === "Move") {
      expect(moves[0]!.node.label).toBe("f2");
    }
  });

  it("does not report a Move when the old parent is itself deleted", () => {
    const a = tree("root", [tree("outer", [tree("fn", [leaf("body", "x")], "x")])]);
    const b = tree("root", []);
    const changes = diffTrees(a, b).changes;
    const moves = changes.filter((c) => c.type === "Move");
    expect(moves).toHaveLength(0);
    expect(changes.some((c) => c.type === "Delete")).toBe(true);
  });
});

describe("generateEditScript: inserts and deletes", () => {
  it("absorbs a whole deleted subtree into one Delete", () => {
    const a = tree("root", [tree("fn", [leaf("body", "x"), leaf("num", "1")], "x")]);
    const b = tree("root", []);
    const changes = diffTrees(a, b).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("Delete");
  });

  it("absorbs a whole added subtree into one Insert", () => {
    const a = tree("root", []);
    const b = tree("root", [tree("fn", [leaf("body", "x"), leaf("num", "1")], "x")]);
    const changes = diffTrees(a, b).changes;
    // The emptied old root is one Delete; the added fn is one Insert.
    expect(changes).toHaveLength(2);
    expect(changes.filter((c) => c.type === "Insert")).toHaveLength(1);
    expect(changes.filter((c) => c.type === "Delete")).toHaveLength(1);
    const insert = changes.find((c) => c.type === "Insert");
    expect(insert!.node.label).toBe("x");
  });

  it("carries the ancestry chain, nearest first", () => {
    const a = tree("root", [
      tree("class", [tree("fn", [leaf("num", undefined, "1")], "work")], "Worker"),
    ]);
    const b = tree("root", [
      tree("class", [tree("fn", [leaf("num", undefined, "2")], "work")], "Worker"),
    ]);
    const changes = diffTrees(a, b).changes;
    const update = changes.find((c) => c.type === "Update");
    expect(update).toBeDefined();
    expect(update!.context).toEqual([
      { kind: "fn", label: "work" },
      { kind: "class", label: "Worker" },
      { kind: "root" },
    ]);
  });
});
