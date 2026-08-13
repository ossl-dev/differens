import { describe, expect, it } from "bun:test";
import { diffTrees } from "./index";
import type { MatchOptions } from "./actions";
import { DEFAULT_OPTIONS } from "./actions";
import {
  Matching,
  bottomUpMatch,
  indexTree,
  lo,
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

const OPTS: MatchOptions = { ...DEFAULT_OPTIONS };

function match(oldRoot: Node, newRoot: Node, opts: MatchOptions = OPTS): Matching {
  const oldIdx = indexTree(oldRoot);
  const newIdx = indexTree(newRoot);
  const m = new Matching(oldIdx.n, newIdx.n);
  topDownMatch(oldIdx, newIdx, m, opts);
  bottomUpMatch(oldIdx, newIdx, m, opts);
  recoverLeaves(oldIdx, newIdx, m);
  recoverContainers(oldIdx, newIdx, m);
  recoverLeaves(oldIdx, newIdx, m);
  return m;
}

/** Count of linked old nodes. */
function linked(m: Matching): number {
  let n = 0;
  for (const v of m.oldToNew) if (v >= 0) n++;
  return n;
}

describe("indexTree", () => {
  const root = tree("root", [
    tree("fn", [leaf("name", "a"), leaf("num", "1")], "a"),
    tree("fn", [leaf("name", "b")], "b"),
  ]);
  const idx = indexTree(root);

  it("indexes every node in postorder", () => {
    expect(idx.n).toBe(6);
    // Postorder: children before parents, and the root last.
    expect(idx.nodes[idx.n - 1]).toBe(root);
  });

  it("records parent, position, and subtree sizes", () => {
    // Root has both fns as children.
    const rootId = idx.n - 1;
    expect(idx.size[rootId]).toBe(6);
    const fnIds = idx.nodes.map((n, i) => (n.kind === "fn" ? i : -1)).filter((i) => i >= 0);
    expect(fnIds).toHaveLength(2);
    for (const id of fnIds) {
      expect(idx.parent[id]).toBe(rootId);
      expect(idx.size[id]).toBeGreaterThanOrEqual(2);
    }
  });

  it("tracks maxHeight", () => {
    expect(idx.maxHeight).toBe(3);
  });

  it("computes the first descendant id via lo()", () => {
    const rootId = idx.n - 1;
    expect(lo(idx, rootId)).toBe(0);
    const leafId = idx.nodes.findIndex((n) => n.kind === "num");
    expect(lo(idx, leafId)).toBe(leafId);
  });
});

describe("Matching.link", () => {
  it("links pairs and refuses to relink either side", () => {
    const m = new Matching(3, 3);
    m.link(0, 0);
    expect(m.oldToNew[0]).toBe(0);
    expect(m.newToOld[0]).toBe(0);
    // Old side already taken.
    m.link(0, 1);
    expect(m.oldToNew[0]).toBe(0);
    expect(m.newToOld[1]).toBe(-1);
    // New side already taken.
    m.link(1, 0);
    expect(m.oldToNew[1]).toBe(-1);
    expect(m.newToOld[0]).toBe(0);
  });
});

describe("topDownMatch", () => {
  it("matches identical trees completely", () => {
    const a = tree("root", [tree("fn", [leaf("name", "x")], "x")]);
    const b = tree("root", [tree("fn", [leaf("name", "x")], "x")]);
    const m = match(a, b);
    expect(linked(m)).toBe(3);
  });

  it("matches a moved subtree regardless of position", () => {
    const a = tree("root", [
      tree("fn", [leaf("body", "1")], "one"),
      tree("fn", [leaf("body", "2")], "two"),
    ]);
    const b = tree("root", [
      tree("fn", [leaf("body", "2")], "two"),
      tree("fn", [leaf("body", "1")], "one"),
    ]);
    const m = match(a, b);
    // The two fns match their old selves, not their new neighbors.
    const oldIdx = indexTree(a);
    const fnOne = oldIdx.nodes.findIndex((n) => n.label === "one");
    const newIdx = indexTree(b);
    const partner = newIdx.nodes[m.oldToNew[fnOne]!];
    expect(partner?.label).toBe("one");
  });

  it("does not cross-match leaves that only share a kind", () => {
    const a = tree("root", [leaf("x", "shared"), leaf("a", "1")]);
    const b = tree("root", [leaf("x", "shared"), leaf("b", "2")]);
    const m = match(a, b);
    // "shared" matched its twin; "a"/"b" stayed unmatched.
    const oldIdx = indexTree(a);
    const shared = oldIdx.nodes.findIndex((n) => n.label === "shared");
    expect(m.oldToNew[shared]).toBeGreaterThanOrEqual(0);
    const aLeaf = oldIdx.nodes.findIndex((n) => n.label === "1");
    expect(m.oldToNew[aLeaf]).toBe(-1);
  });

  it("withholds ambiguous short subtrees whose parents are not paired", () => {
    // Two identical short leaves under parents that never match: pairing
    // either candidate is a guess, so neither is taken while the parents
    // themselves are unpaired.
    const a = tree("oldKind", [leaf("x", "same"), leaf("x", "same")]);
    const b = tree("newKind", [leaf("x", "same"), leaf("x", "same")]);
    const m = match(a, b, { ...OPTS, minHeight: 4 });
    expect(linked(m)).toBe(0);
  });
});

describe("bottomUpMatch", () => {
  it("pairs containers by Dice coefficient of matched descendants", () => {
    const a = tree("root", [tree("container", [leaf("id", "x1"), leaf("id", "x2")])]);
    const b = tree("root", [
      tree("container", [leaf("id", "x1"), leaf("id", "x2"), leaf("id", "y")]),
    ]);
    const m = match(a, b);
    const oldIdx = indexTree(a);
    const box = oldIdx.nodes.findIndex((n) => n.kind === "container");
    expect(m.oldToNew[box]).toBeGreaterThanOrEqual(0);
  });

  it("refuses a container pair below the ratio", () => {
    const a = tree("root", [tree("container", [leaf("id", "x1"), leaf("id", "x2")])]);
    const b = tree("root", [
      tree("container", [
        leaf("id", "x1"),
        leaf("id", "x2"),
        leaf("id", "y"),
        leaf("id", "z"),
        leaf("id", "w"),
      ]),
    ]);
    const m = match(a, b, { ...OPTS, bottomUpRatio: 0.9 });
    const oldIdx = indexTree(a);
    const box = oldIdx.nodes.findIndex((n) => n.kind === "container");
    expect(m.oldToNew[box]).toBe(-1);
  });

  it("caps the candidate list without losing the best match", () => {
    // Five new containers compete; the candidate cap keeps the run bounded
    // and the ranking keeps the one holding most of the old descendants.
    const ids = (ns: number[]) => ns.map((i) => leaf("id", `x${i}`));
    const a = tree("root", [tree("container", ids([0, 1, 2, 3, 4, 5]))]);
    const b = tree("root", [
      tree("container", ids([0])),
      tree("container", ids([1])),
      tree("container", ids([2])),
      tree("container", ids([3])),
      tree("container", ids([4, 5])),
    ]);
    const m = match(a, b, { ...OPTS, bottomUpRatio: 0.5 });
    const oldIdx = indexTree(a);
    const newIdx = indexTree(b);
    const box = oldIdx.nodes.findIndex((n) => n.kind === "container");
    const partner = m.oldToNew[box]!;
    expect(partner).toBeGreaterThanOrEqual(0);
    expect(newIdx.nodes[partner]!.children.length).toBe(2);
  });

  it("leaves containers with no matched descendants alone", () => {
    const a = tree("root", [tree("container", [leaf("id", "x1"), leaf("id", "x2")])]);
    const b = tree("root", [tree("other", [leaf("id", "y1")])]);
    const m = match(a, b);
    expect(linked(m)).toBe(0);
  });
});

describe("recoverLeaves", () => {
  it("pairs value-changed leaves inside a matched parent", () => {
    const a = tree("root", [tree("assign", [leaf("num", "1")])]);
    const b = tree("root", [tree("assign", [leaf("num", "2")])]);
    const m = match(a, b);
    expect(linked(m)).toBe(3);
  });

  it("zips by position past 64 unmatched siblings instead of building an LCS table", () => {
    // 68 value-changed leaves (all unmatched) plus two unique identical
    // leaves (matched, so the block pairs). Past 64 unmatched siblings the
    // LCS table is skipped and pairing is positional.
    const kids = (variant: "old" | "new") => [
      ...Array.from({ length: 68 }, (_, i) => leaf("item", `k${i}`, `${variant}${i}`)),
      leaf("item", "k68", "same68"),
      leaf("item", "k69", "same69"),
    ];
    const a = tree("root", [tree("block", kids("old"))]);
    const b = tree("root", [tree("block", kids("new"))]);
    const m = match(a, b);
    const oldIdx = indexTree(a);
    const newIdx = indexTree(b);
    const k0 = oldIdx.nodes.findIndex((n) => n.label === "k0" && n.value === "old0");
    expect(m.oldToNew[k0]).toBeGreaterThanOrEqual(0);
    // Positional pairing: k0 pairs with the new k0, not some other item.
    expect(newIdx.nodes[m.oldToNew[k0]!]!.label).toBe("k0");
  });

  it("does not pair unmatched containers as leaves", () => {
    const a = tree("root", [tree("block", [tree("inner", [leaf("x", "1")])])]);
    const b = tree("root", [tree("block", [tree("inner", [leaf("x", "2")])])]);
    const m = match(a, b);
    const oldIdx = indexTree(a);
    const inner = oldIdx.nodes.findIndex((n) => n.kind === "inner");
    const partner = m.oldToNew[inner]!;
    const newIdx = indexTree(b);
    // Containers pair via Dice, not the leaf-recovery positional zip.
    expect(partner).toBeGreaterThanOrEqual(0);
    expect(newIdx.nodes[partner]!.kind).toBe("inner");
  });
});

describe("hash collision safety", () => {
  it("refuses to weld subtrees that only share a forged content hash", () => {
    // FNV-1a folded to 53 bits is not collision-free: an equal hash is a
    // candidate, not a verdict. Forge a collision on the one changed leaf:
    // same kind, same size, different content, identical contentHash. Without
    // content verification the whole fn subtree pairs as identical and the
    // change vanishes; with it, the edit surfaces as a Renamed leaf.
    const a = tree("root", [tree("fn", [leaf("name", "x"), leaf("arg", "1")])]);
    const b = tree("root", [tree("fn", [leaf("name", "x"), leaf("arg", "2")])]);
    b.children[0]!.children[1]!.contentHash = a.children[0]!.children[1]!.contentHash;

    const result = diffTrees(a, b);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.type).toBe("Update");
    if (change.type === "Update" && change.detail.kind === "Renamed") {
      expect(change.detail.from).toBe("1");
      expect(change.detail.to).toBe("2");
    }
  });

  it("verifies values, not just kinds, on hash-equal subtrees", () => {
    const a = tree("root", [tree("fn", [leaf("name", "x"), leaf("arg", undefined, "1")])]);
    const b = tree("root", [tree("fn", [leaf("name", "x"), leaf("arg", undefined, "2")])]);
    b.children[0]!.children[1]!.contentHash = a.children[0]!.children[1]!.contentHash;

    const result = diffTrees(a, b);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.type).toBe("Update");
    if (change.type === "Update" && change.detail.kind === "ValueChanged") {
      expect(change.detail.from).toBe("1");
      expect(change.detail.to).toBe("2");
    }
  });

  it("verifies labels, not just kinds, on hash-equal subtrees", () => {
    // Same shape and kinds throughout, but a different label: a hash
    // collision on the label must not pair `add` with `sub`.
    const a = tree("root", [tree("fn", [leaf("name", "add"), leaf("arg", "1")])]);
    const b = tree("root", [tree("fn", [leaf("name", "sub"), leaf("arg", "1")])]);
    b.children[0]!.children[0]!.contentHash = a.children[0]!.children[0]!.contentHash;

    const result = diffTrees(a, b);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.type).toBe("Update");
    if (change.type === "Update" && change.detail.kind === "Renamed") {
      expect(change.detail.from).toBe("add");
      expect(change.detail.to).toBe("sub");
    }
  });
});
