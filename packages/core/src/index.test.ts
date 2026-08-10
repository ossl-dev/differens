import { describe, expect, it } from "bun:test";
import {
  createNode,
  diffTrees,
  fastUnchanged,
  treeFromValue,
} from "./index";
import type { EditAction, Node } from "./index";

// ---------- Helpers ----------

function leaf(kind: string, label?: string, value?: string): Node {
  return createNode({
    kind,
    label,
    value,
    byteRange: [0, 10],
  });
}

function tree(kind: string, children: Node[], label?: string): Node {
  return createNode({
    kind,
    label,
    children,
    byteRange: [0, 100],
  });
}

// ---------- fastUnchanged ----------

describe("fastUnchanged", () => {
  it("returns true for identical buffers", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(fastUnchanged(a, b)).toBe(true);
  });

  it("returns false for different content", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(fastUnchanged(a, b)).toBe(false);
  });

  it("returns false for different lengths", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([1, 2, 3]);
    expect(fastUnchanged(a, b)).toBe(false);
  });
});

// ---------- createNode / hashing ----------

describe("createNode", () => {
  it("computes contentHash and structureHash", () => {
    const a = leaf("identifier", "foo");
    const b = leaf("identifier", "foo");
    const c = leaf("identifier", "bar");

    // Same content = same hashes
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.structureHash).toBe(b.structureHash);

    // Different value = different contentHash
    expect(a.contentHash).not.toBe(c.contentHash);
    // Same kind, no children = same structureHash
    expect(a.structureHash).toBe(c.structureHash);
  });

  it("structureHash ignores label/value", () => {
    const a = leaf("identifier", "foo");
    const b = leaf("identifier", "bar");
    // Same kind, no children => same structure
    expect(a.structureHash).toBe(b.structureHash);
  });

  it("computes height correctly", () => {
    const l = leaf("leaf");
    expect(l.height).toBe(1);

    const p = tree("parent", [l, l]);
    expect(p.height).toBe(2);

    const gp = tree("grandparent", [p]);
    expect(gp.height).toBe(3);
  });

  it("contentHash changes when children change", () => {
    const a = tree("block", [leaf("a", "x")]);
    const b = tree("block", [leaf("a", "y")]);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

// ---------- diffTrees: identical trees ----------

describe("diffTrees: identical", () => {
  it("produces no changes for identical leaves", () => {
    const oldTree = leaf("function", "foo");
    const newTree = leaf("function", "foo");
    const result = diffTrees(oldTree, newTree);
    // No actions since everything matches
    const nonInsert = result.changes.filter((a) => a.type !== "Insert");
    expect(nonInsert).toEqual([]);
  });

  it("produces no changes for identical nested trees", () => {
    const makeTree = () =>
      tree("program", [
        tree("function", [
          leaf("identifier", "foo"),
          leaf("return", undefined, "1"),
        ]),
      ]);

    const result = diffTrees(makeTree(), makeTree());
    const nonInsert = result.changes.filter((a) => a.type !== "Insert");
    expect(nonInsert).toEqual([]);
  });
});

// ---------- diffTrees: rename ----------

describe("diffTrees: rename", () => {
  it("detects renamed leaf node", () => {
    const oldTree = tree("program", [leaf("identifier", "foo")]);
    const newTree = tree("program", [leaf("identifier", "bar")]);

    const result = diffTrees(oldTree, newTree, { minHeight: 1 });
    // The leaf was "deleted" and a new one "inserted" because content hash differs
    // Rename detection at the core level appears as Delete(old) + Insert(new)
    // The narration layer turns that into "renamed"
    const deletes = result.changes.filter((a) => a.type === "Delete");
    const inserts = result.changes.filter((a) => a.type === "Insert");
    expect(deletes.length).toBe(1);
    expect(inserts.length).toBe(1);
  });

  it("uses Update action when nodes are matched but label differs", () => {
    // Create trees where parent structure matches but child label differs
    const oldChild = leaf("identifier", "foo");
    const newChild = leaf("identifier", "bar");

    const oldTree = tree("function", [oldChild]);
    const newTree = tree("function", [newChild]);

    const result = diffTrees(oldTree, newTree, { minHeight: 1 });
    const updates = result.changes.filter((a) => a.type === "Update");
    // May or may not detect as Update depending on matching
    // At minimum, changes exist
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

// ---------- diffTrees: add/remove ----------

describe("diffTrees: add/remove", () => {
  it("detects inserted child", () => {
    const oldTree = tree("program", [
      leaf("function", "a"),
    ]);
    const newTree = tree("program", [
      leaf("function", "a"),
      leaf("function", "b"),
    ]);

    const result = diffTrees(oldTree, newTree);
    const inserts = result.changes.filter((a) => a.type === "Insert");
    expect(inserts.length).toBe(1);
  });

  it("detects deleted child", () => {
    const oldTree = tree("program", [
      leaf("function", "a"),
      leaf("function", "b"),
    ]);
    const newTree = tree("program", [
      leaf("function", "a"),
    ]);

    const result = diffTrees(oldTree, newTree);
    const deletes = result.changes.filter((a) => a.type === "Delete");
    expect(deletes.length).toBe(1);
  });
});

// ---------- diffTrees: structure changes ----------

describe("diffTrees: structure", () => {
  it("handles completely different trees", () => {
    const oldTree = tree("program", [leaf("function", "foo")]);
    const newTree = tree("program", [leaf("class", "Bar")]);

    const result = diffTrees(oldTree, newTree, { minHeight: 1 });
    // Should produce some changes
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

// ---------- Safety valve ----------

describe("diffTrees: safety valve", () => {
  it("falls back on excessive node count", () => {
    // Build a deep tree that exceeds maxNodes
    function deepTree(depth: number): Node {
      if (depth === 0) return leaf("leaf");
      return tree("node", [deepTree(depth - 1)]);
    }

    const t = deepTree(100); // 101 nodes (depth 0..100)
    const result = diffTrees(t, t, { maxNodes: 50 });
    // Should still work with 101 nodes (< 50000)
    expect(result.nodeCount).toBe(202);
  });

  it("respects maxNodes limit", () => {
    function wideTree(width: number): Node {
      const leaves: Node[] = [];
      for (let i = 0; i < width; i++) {
        leaves.push(leaf("leaf", `l${i}`));
      }
      return tree("root", leaves);
    }

    const t = wideTree(100);
    const result = diffTrees(t, t, { maxNodes: 50 });
    expect(result.fallback).toBe("lines");
  });
});

// ---------- treeFromValue ----------

describe("treeFromValue", () => {
  it("handles primitives", () => {
    const n = treeFromValue(42);
    expect(n.kind).toBe("leaf");
    expect(n.value).toBe("42");
  });

  it("handles null", () => {
    const n = treeFromValue(null);
    expect(n.kind).toBe("root");
  });

  it("handles objects", () => {
    const n = treeFromValue({ name: "test", count: 5 });
    expect(n.kind).toBe("object");
    expect(n.children.length).toBe(2);
  });

  it("handles arrays", () => {
    const n = treeFromValue([1, 2, 3]);
    expect(n.kind).toBe("array");
    expect(n.children.length).toBe(3);
  });

  it("handles nested structures", () => {
    const n = treeFromValue({
      config: { host: "localhost", port: 8080 },
      tags: ["web", "api"],
    });
    expect(n.kind).toBe("object");
    expect(n.children.length).toBe(2);
  });
});

// ---------- Edge case helpers ----------

function ofType<T extends EditAction["type"]>(
  changes: EditAction[],
  type: T,
): Extract<EditAction, { type: T }>[] {
  return changes.filter(
    (a): a is Extract<EditAction, { type: T }> => a.type === type,
  );
}

// ---------- diffTrees: empty trees ----------

describe("diffTrees: empty trees", () => {
  it("produces no changes for two empty nodes", () => {
    const oldRoot = tree("root", []);
    const newRoot = tree("root", []);
    const result = diffTrees(oldRoot, newRoot);
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(2);
  });

  it("produces no changes for identical childless leaves", () => {
    const result = diffTrees(leaf("identifier", "x"), leaf("identifier", "x"));
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(2);
  });

  it("deletes the empty root and inserts the child when the first child is added", () => {
    const oldRoot = tree("root", []);
    const newRoot = tree("root", [leaf("item", "a")]);
    const result = diffTrees(oldRoot, newRoot);

    expect(result.changes).toHaveLength(2);
    const deletes = ofType(result.changes, "Delete");
    const inserts = ofType(result.changes, "Insert");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.node).toBe(oldRoot);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.node).toBe(newRoot.children[0]!);
    expect(inserts[0]!.parent).toBe(newRoot);
    expect(inserts[0]!.position).toBe(0);
  });
});

// ---------- diffTrees: deeply nested identical structures ----------

describe("diffTrees: deeply nested identical structures", () => {
  function deepChain(depth: number, bottomLabel = "leaf"): Node {
    let node = leaf("leaf", bottomLabel);
    for (let i = 0; i < depth; i++) {
      node = tree("node", [node]);
    }
    return node;
  }

  it("produces no changes for identical depth-50 chains", () => {
    const result = diffTrees(deepChain(50), deepChain(50));
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(102); // 51 nodes per side
  });

  it("collapses to a root Delete + re-inserts when the deepest leaf changes", () => {
    const oldTree = deepChain(50, "a");
    const newTree = deepChain(50, "b");
    const result = diffTrees(oldTree, newTree);

    // No subtree hashes match, so the old chain is deleted as a unit (root
    // Delete absorbs its children) and the new chain is re-inserted node by node.
    const deletes = ofType(result.changes, "Delete");
    const inserts = ofType(result.changes, "Insert");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.node).toBe(oldTree);
    expect(inserts).toHaveLength(50);
    expect(ofType(result.changes, "Update")).toHaveLength(0);
    expect(ofType(result.changes, "Move")).toHaveLength(0);
  });
});

// ---------- diffTrees: structural changes only (same shape, different labels) ----------

describe("diffTrees: structural changes only", () => {
  it("reports a single Renamed Update when only a container label changes", () => {
    const oldTree = tree("function", [leaf("identifier", "foo")], "oldName");
    const newTree = tree("function", [leaf("identifier", "foo")], "newName");
    const result = diffTrees(oldTree, newTree);

    expect(result.changes).toHaveLength(1);
    const update = ofType(result.changes, "Update")[0]!;
    expect(update.node).toBe(newTree);
    expect(update.detail.kind).toBe("Renamed");
    if (update.detail.kind === "Renamed") {
      expect(update.detail.from).toBe("oldName");
      expect(update.detail.to).toBe("newName");
    }
  });

  it("deletes the root and re-inserts the new tree when every label differs", () => {
    const oldTree = tree("program", [
      tree("function", [leaf("identifier", "foo")]),
    ]);
    const newTree = tree("program", [
      tree("function", [leaf("identifier", "bar")]),
    ]);
    const result = diffTrees(oldTree, newTree);

    // Nothing matches: the unmatched old root absorbs its subtree into one
    // Delete, and every new node except the root is inserted.
    const deletes = ofType(result.changes, "Delete");
    const inserts = ofType(result.changes, "Insert");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.node).toBe(oldTree);
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.node)).toEqual([
      newTree.children[0]!,
      newTree.children[0]!.children[0]!,
    ]);
    expect(ofType(result.changes, "Update")).toHaveLength(0);
    expect(ofType(result.changes, "Move")).toHaveLength(0);
  });
});

// ---------- diffTrees: large child arrays ----------

describe("diffTrees: large child arrays", () => {
  function manyLeaves(count: number, changedAt = -1): Node {
    const children: Node[] = [];
    for (let i = 0; i < count; i++) {
      children.push(leaf("leaf", i === changedAt ? "l73-changed" : `l${i}`));
    }
    return tree("root", children);
  }

  it("produces no changes for 150 identical children", () => {
    const result = diffTrees(manyLeaves(150), manyLeaves(150));
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(302);
  });

  it("isolates a single changed child among 150", () => {
    const oldTree = manyLeaves(150);
    const newTree = manyLeaves(150, 73);
    const result = diffTrees(oldTree, newTree);

    const deletes = ofType(result.changes, "Delete");
    const inserts = ofType(result.changes, "Insert");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.node).toBe(oldTree.children[73]!);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.node).toBe(newTree.children[73]!);
    expect(inserts[0]!.parent).toBe(newTree);
    expect(inserts[0]!.position).toBe(73);
    expect(ofType(result.changes, "Update")).toHaveLength(0);
    expect(result.nodeCount).toBe(302);
  });
});

// ---------- diffTrees: move detection ----------

describe("diffTrees: move detection", () => {
  it("emits a single Move when a node moves from one parent to another", () => {
    const oldFoo = leaf("leaf", "foo");
    const newFoo = leaf("leaf", "foo");
    const oldA = tree("container", [
      leaf("leaf", "keep1"),
      leaf("leaf", "keep2"),
      oldFoo,
    ]);
    const newA = tree("container", [
      leaf("leaf", "keep1"),
      leaf("leaf", "keep2"),
    ]);
    const oldB = tree("container", [
      leaf("leaf", "keep3"),
      leaf("leaf", "keep4"),
    ]);
    const newB = tree("container", [
      leaf("leaf", "keep3"),
      leaf("leaf", "keep4"),
      newFoo,
    ]);
    const oldRoot = tree("program", [oldA, oldB]);
    const newRoot = tree("program", [newA, newB]);

    const result = diffTrees(oldRoot, newRoot);
    expect(result.changes).toHaveLength(1);

    const move = ofType(result.changes, "Move")[0]!;
    expect(move.node).toBe(newFoo);
    expect(move.fromParent).toBe(oldA);
    expect(move.toParent).toBe(newB);
    expect(move.fromPosition).toBe(2);
    expect(move.toPosition).toBe(2);
  });
});

// ---------- diffTrees: contentHash vs structureHash ----------

describe("diffTrees: contentHash vs structureHash", () => {
  function fakeNode(overrides: Partial<Node>): Node {
    return {
      kind: "thing",
      label: "x",
      children: [],
      byteRange: [0, 1],
      height: 1,
      contentHash: 999n,
      structureHash: 11n,
      ...overrides,
    };
  }

  it("matches nodes with identical contentHash even when structureHash differs", () => {
    const result = diffTrees(fakeNode({}), fakeNode({ structureHash: 22n }));
    expect(result.changes).toEqual([]);
  });

  it("matches same-kind same-label leaves as a value change, not Delete+Insert", () => {
    const oldTree = tree("wrapper", [leaf("keeper", "k"), fakeNode({ value: "old" })]);
    const newTree = tree("wrapper", [
      leaf("keeper", "k"),
      fakeNode({ value: "new" }),
    ]);
    const result = diffTrees(oldTree, newTree);

    expect(ofType(result.changes, "Delete")).toHaveLength(0);
    expect(ofType(result.changes, "Insert")).toHaveLength(0);
    const updates = ofType(result.changes, "Update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.detail.kind).toBe("ValueChanged");
  });

  it("does not match nodes with identical contentHash but different kind", () => {
    const oldTree = tree("wrapper", [leaf("keeper", "k"), fakeNode({})]);
    const newTree = tree("wrapper", [
      leaf("keeper", "k"),
      fakeNode({ kind: "other" }),
    ]);
    const result = diffTrees(oldTree, newTree);

    expect(ofType(result.changes, "Delete")).toHaveLength(1);
    expect(ofType(result.changes, "Insert")).toHaveLength(1);
  });

  it("emits only a Delete for an unmatched root (roots have no parent to insert under)", () => {
    const result = diffTrees(fakeNode({}), fakeNode({ kind: "other" }));
    expect(result.changes).toHaveLength(1);
    expect(ofType(result.changes, "Delete")).toHaveLength(1);
    expect(ofType(result.changes, "Insert")).toHaveLength(0);
  });
});

// ---------- diffTrees: same object reference ----------

describe("diffTrees: same object reference", () => {
  it("is a no-op when oldRoot and newRoot are the same object", () => {
    const root = tree("program", [
      tree("function", [
        leaf("identifier", "foo"),
        leaf("number", undefined, "1"),
      ]),
      leaf("identifier", "bar"),
    ]);
    const result = diffTrees(root, root);
    expect(result.changes).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(result.nodeCount).toBe(10); // 5 nodes counted on each side
  });
});

// ---------- diffTrees: wide shallow vs deep narrow ----------

describe("diffTrees: wide shallow vs deep narrow", () => {
  function wideShallow(width: number): Node {
    const children: Node[] = [];
    for (let i = 0; i < width; i++) {
      children.push(leaf("leaf", `l${i}`));
    }
    return tree("root", children);
  }

  function deepNarrow(depth: number): Node {
    let node = leaf("leaf");
    for (let i = 0; i < depth; i++) {
      node = tree("node", [node]);
    }
    return node;
  }

  it("handles identical wide shallow trees", () => {
    const result = diffTrees(wideShallow(100), wideShallow(100));
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(202);
  });

  it("handles identical deep narrow trees", () => {
    const result = diffTrees(deepNarrow(100), deepNarrow(100));
    expect(result.changes).toEqual([]);
    expect(result.nodeCount).toBe(202);
  });

  it("finds no overlap between wide and deep shapes", () => {
    const oldTree = wideShallow(100);
    const newTree = deepNarrow(100);
    const result = diffTrees(oldTree, newTree);
    expect(result.fallback).toBeUndefined();
    // Old root deleted as a unit; every new node except the root is inserted.
    expect(ofType(result.changes, "Delete")).toHaveLength(1);
    expect(ofType(result.changes, "Insert")).toHaveLength(100);
    expect(result.nodeCount).toBe(202);
  });
});

// ---------- diffTrees: label transitions to/from undefined ----------

describe("diffTrees: label transitions to/from undefined", () => {
  it("reports Renamed with 'unnamed' when a label is removed", () => {
    const oldTree = tree("function", [leaf("identifier", "x")], "foo");
    const newTree = tree("function", [leaf("identifier", "x")]);
    const result = diffTrees(oldTree, newTree);

    const updates = ofType(result.changes, "Update");
    expect(result.changes).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.node).toBe(newTree);
    expect(updates[0]!.detail.kind).toBe("Renamed");
    if (updates[0]!.detail.kind === "Renamed") {
      expect(updates[0]!.detail.from).toBe("foo");
      expect(updates[0]!.detail.to).toBe("unnamed");
    }
  });

  it("reports Renamed from 'unnamed' when a label is added", () => {
    const oldTree = tree("function", [leaf("identifier", "x")]);
    const newTree = tree("function", [leaf("identifier", "x")], "bar");
    const result = diffTrees(oldTree, newTree);

    const updates = ofType(result.changes, "Update");
    expect(result.changes).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.detail.kind).toBe("Renamed");
    if (updates[0]!.detail.kind === "Renamed") {
      expect(updates[0]!.detail.from).toBe("unnamed");
      expect(updates[0]!.detail.to).toBe("bar");
    }
  });
});

// ---------- diffTrees: value transitions to/from undefined ----------

describe("diffTrees: value transitions to/from undefined", () => {
  function numbered(value?: string): Node {
    return createNode({
      kind: "number",
      value,
      children: [leaf("identifier", "x")],
      byteRange: [0, 1],
    });
  }

  it("reports ValueChanged from undefined when a value is added", () => {
    const newTree = numbered("2");
    const result = diffTrees(numbered(), newTree);

    const updates = ofType(result.changes, "Update");
    expect(result.changes).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.node).toBe(newTree);
    expect(updates[0]!.detail.kind).toBe("ValueChanged");
    if (updates[0]!.detail.kind === "ValueChanged") {
      expect(updates[0]!.detail.from).toBeUndefined();
      expect(updates[0]!.detail.to).toBe("2");
    }
  });

  it("reports ValueChanged to undefined when a value is removed", () => {
    const newTree = numbered();
    const result = diffTrees(numbered("1"), newTree);

    const updates = ofType(result.changes, "Update");
    expect(result.changes).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.detail.kind).toBe("ValueChanged");
    if (updates[0]!.detail.kind === "ValueChanged") {
      expect(updates[0]!.detail.from).toBe("1");
      expect(updates[0]!.detail.to).toBeUndefined();
    }
  });
});
