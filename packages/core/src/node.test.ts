import { describe, expect, it } from "bun:test";
import { createNode, treeFromValue } from "./node";

function leaf(kind = "leaf", label?: string, value?: string) {
  return createNode({ kind, label, value, byteRange: [0, 1] });
}

function tree(kind: string, children: ReturnType<typeof leaf>[], label?: string) {
  return createNode({ kind, label, children, byteRange: [0, 1] });
}

describe("createNode", () => {
  it("computes height from children", () => {
    expect(leaf("leaf").height).toBe(1);
    expect(tree("root", [leaf()]).height).toBe(2);
    expect(tree("root", [tree("inner", [leaf()])]).height).toBe(3);
  });

  it("hashes identically for identical trees", () => {
    const a = tree("fn", [leaf("name", "foo"), leaf("num", "1")], "foo");
    const b = tree("fn", [leaf("name", "foo"), leaf("num", "1")], "foo");
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.structureHash).toBe(b.structureHash);
  });

  it("changes contentHash when the label changes", () => {
    const a = tree("fn", [leaf("name", "foo")], "foo");
    const b = tree("fn", [leaf("name", "foo")], "bar");
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("changes contentHash when a descendant value changes", () => {
    const a = tree("fn", [leaf("name", "foo"), leaf("num", "1")]);
    const b = tree("fn", [leaf("name", "foo"), leaf("num", "2")]);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("keeps structureHash stable when only labels and values change", () => {
    const a = tree("fn", [leaf("name", "foo"), leaf("num", "1")], "foo");
    const b = tree("fn", [leaf("name", "bar"), leaf("num", "2")], "bar");
    expect(a.structureHash).toBe(b.structureHash);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("changes structureHash when child kinds change", () => {
    const a = tree("fn", [leaf("name", "foo"), leaf("num", "1")]);
    const b = tree("fn", [leaf("other", "foo"), leaf("num", "1")]);
    expect(a.structureHash).not.toBe(b.structureHash);
  });

  it("changes both hashes when children are reordered", () => {
    const a = tree("root", [leaf("a", "1"), leaf("b", "2")]);
    const b = tree("root", [leaf("b", "2"), leaf("a", "1")]);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.structureHash).not.toBe(b.structureHash);
  });

  it("is deterministic across calls", () => {
    const build = () => tree("fn", [leaf("name", "foo")], "foo");
    expect(build().contentHash).toBe(build().contentHash);
  });
});

describe("treeFromValue", () => {
  it("wraps primitives as leaves", () => {
    for (const [value, kind, expected] of [
      [42, "root", "42"],
      ["host", "host", "host"],
      [true, "flag", "true"],
    ] as const) {
      const n = treeFromValue(value, kind);
      expect(n.kind).toBe("leaf");
      expect(n.label).toBe(kind);
      expect(n.value).toBe(expected);
    }
  });

  it("wraps null and undefined as root nodes", () => {
    expect(treeFromValue(null).kind).toBe("root");
    expect(treeFromValue(null).value).toBe("null");
    expect(treeFromValue(undefined).value).toBe("undefined");
  });

  it("builds arrays with indexed labels", () => {
    const n = treeFromValue([1, "two"]);
    expect(n.kind).toBe("array");
    expect(n.children).toHaveLength(2);
    expect(n.children[0]!.label).toBe("root[0]");
    expect(n.children[1]!.label).toBe("root[1]");
  });

  it("stringifies exotic values through the fallback branch", () => {
    const n = treeFromValue(() => {});
    expect(n.value).toContain("=>");
    const s = treeFromValue(Symbol("x"));
    expect(s.value).toContain("Symbol");
  });

  it("builds nested objects with key labels", () => {
    const n = treeFromValue({ db: { pool: { max: 10 } } });
    expect(n.kind).toBe("object");
    expect(n.label).toBe("root");
    const db = n.children[0]!;
    expect(db.label).toBe("db");
    const pool = db.children[0]!;
    expect(pool.label).toBe("pool");
    const max = pool.children[0]!;
    expect(max.kind).toBe("leaf");
    expect(max.label).toBe("max");
    expect(max.value).toBe("10");
  });
});
