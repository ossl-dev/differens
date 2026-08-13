import { describe, expect, it } from "bun:test";
import type { Node } from "@ossl-dev/differens-core";
import { parseData } from "./data";
import { Tier, diffWithTier } from "./index";

function leafValues(
  n: Node,
  out: { label: string; value: string }[] = [],
): { label: string; value: string }[] {
  if (n.children.length === 0 && n.value !== undefined)
    out.push({ label: n.label ?? "", value: n.value });
  for (const c of n.children) leafValues(c, out);
  return out;
}

describe("parseData: JSON", () => {
  it("parses objects and arrays", () => {
    const tree = parseData('{"host": "a", "ports": [1, 2]}');
    expect(tree.kind).toBe("object");
    expect(tree.label).toBe("root");
    const host = tree.children.find((c) => c.label === "host")!;
    expect(host.kind).toBe("leaf");
    expect(host.value).toBe("a");
    const ports = tree.children.find((c) => c.label === "ports")!;
    expect(ports.kind).toBe("array");
    expect(ports.children).toHaveLength(2);
  });

  it("falls through to the YAML subset on invalid JSON", () => {
    expect(parseData("{not: json}").kind).toBe("object");
  });

  it("treats a lone scalar as a raw value", () => {
    const tree = parseData("42");
    expect(tree.kind).toBe("leaf");
    expect(tree.value).toBe("42");
  });
});

describe("parseData: YAML", () => {
  it("parses nested mappings", () => {
    const tree = parseData("db:\n  pool:\n    max: 10\n");
    expect(tree.kind).toBe("object");
    expect(tree.label).toBe("root");
    const values = leafValues(tree);
    expect(values).toEqual([{ label: "max", value: "10" }]);
  });

  it("parses sequences of scalars and of objects", () => {
    const tree = parseData("items:\n  - one\n  - two\n");
    const items = tree.children.find((c) => c.label === "items")!;
    expect(items.kind).toBe("array");
    // Sequence elements become indexed leaves under the array node.
    expect(leafValues(items)).toEqual([
      { label: "items[0]", value: "one" },
      { label: "items[1]", value: "two" },
    ]);

    // Sequence items with inline keys flatten to scalars: the subset does
    // not nest objects under sequence items.
    const nested = parseData("items:\n  - name: a\n    port: 1\n  - name: b\n");
    const arr = nested.children.find((c) => c.label === "items")!;
    expect(arr.children).toHaveLength(2);
    expect(leafValues(arr)).toEqual([
      { label: "items[0]", value: "name: a" },
      { label: "items[1]", value: "name: b" },
    ]);
  });

  it("parses booleans, null, numbers, and quoted strings", () => {
    const tree = parseData('on: true\noff: false\nnothing: null\ncount: 3\nname: "quoted"\n');
    const values = leafValues(tree);
    expect(values).toEqual([
      { label: "on", value: "true" },
      { label: "off", value: "false" },
      { label: "", value: "null" }, // nulls carry no label
      { label: "count", value: "3" },
      { label: "name", value: "quoted" },
    ]);
  });

  it("treats a bare sequence item as a skipped line, not a nested object", () => {
    // "-" alone does not start with "- ", and the keys underneath sit at
    // 4-space indent, past the 2-space subset: both are ignored and the
    // parent key holds an empty object.
    const tree = parseData("items:\n  -\n    name: a\n");
    const items = tree.children.find((c) => c.label === "items")!;
    expect(items.kind).toBe("object");
    expect(items.children).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const tree = parseData("# comment\nport: 8080\n");
    expect(leafValues(tree)).toEqual([{ label: "port", value: "8080" }]);
  });

  it("skips a stray line indented deeper than its parent", () => {
    const tree = parseData("a: 1\n  stray: x\nb: 2\n");
    expect(leafValues(tree)).toEqual([
      { label: "a", value: "1" },
      { label: "b", value: "2" },
    ]);
  });

  it("treats an empty nested value without children as null", () => {
    const tree = parseData("db:\n");
    // The db key maps to null, which treeFromValue turns into a childless
    // node keeping the key as its kind.
    const db = tree.children.find((c) => c.value === "null")!;
    expect(db.kind).toBe("db");
  });
});

describe("parseData: TOML", () => {
  it("parses sections and dotted sections", () => {
    const tree = parseData("[server]\nport = 8080\n[server.tls]\nenabled = true\n");
    expect(tree.kind).toBe("object");
    const values = leafValues(tree);
    expect(values).toContainEqual({ label: "port", value: "8080" });
    expect(values).toContainEqual({ label: "enabled", value: "true" });
  });

  it("parses value types: strings, booleans, ints, floats, arrays, bare strings", () => {
    const tree = parseData(
      'name = "app"\nflag = true\ncount = 3\nratio = 0.5\ntags = ["a", "b"]\nbare = hello\nbad = [not json\n',
    );
    const values = leafValues(tree);
    expect(values).toContainEqual({ label: "name", value: "app" });
    expect(values).toContainEqual({ label: "flag", value: "true" });
    expect(values).toContainEqual({ label: "count", value: "3" });
    expect(values).toContainEqual({ label: "ratio", value: "0.5" });
    expect(values).toContainEqual({ label: "bare", value: "hello" });
    // A malformed array falls back to the raw string.
    expect(values).toContainEqual({ label: "bad", value: "[not json" });
  });

  it("keeps a malformed array literal as a raw string", () => {
    const tree = parseData("bad = [not, json]\n");
    expect(leafValues(tree)).toContainEqual({ label: "bad", value: "[not, json]" });
  });

  it("skips lines with no colon or equals", () => {
    const tree = parseData("just some text\nport: 1\n");
    expect(leafValues(tree)).toEqual([{ label: "port", value: "1" }]);
  });

  it("does not parse an empty value as the number zero", () => {
    const tree = parseData("empty =\n");
    expect(leafValues(tree)).toContainEqual({ label: "empty", value: "" });
  });
});

describe("diffWithTier: data scenarios", () => {
  it("reports a key value change as one Update with the key path", () => {
    const result = diffWithTier(
      '{"db": {"pool": {"max": 10}}}',
      '{"db": {"pool": {"max": 25}}}',
      "a.json",
      "a.json",
    );
    expect(result.tier).toBe(Tier.Data);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.type).toBe("Update");
    if (result.changes[0]!.type === "Update") {
      expect(result.changes[0]!.detail.kind).toBe("ValueChanged");
      expect(result.changes[0]!.context[0]).toEqual({ kind: "object", label: "pool" });
    }
  });

  it("reports an added key as one Insert", () => {
    const result = diffWithTier('{"a": 1}', '{"a": 1, "b": 2}', "a.json", "a.json");
    expect(result.changes.filter((c) => c.type === "Insert")).toHaveLength(1);
  });

  it("reports a removed key as one Delete", () => {
    const result = diffWithTier('{"a": 1, "b": 2}', '{"a": 1}', "a.json", "a.json");
    expect(result.changes.filter((c) => c.type === "Delete")).toHaveLength(1);
  });

  it("reports sibling reorder as a Move", () => {
    const result = diffWithTier('{"a": 1, "b": 2}', '{"b": 2, "a": 1}', "a.json", "a.json");
    expect(result.changes.filter((c) => c.type === "Move")).toHaveLength(1);
  });

  it("degrades unparseable data to a raw value diff instead of crashing", () => {
    // Not JSON, YAML, or TOML: both sides become bare scalar leaves that do
    // not match, so the report is a whole-value Delete rather than a crash.
    const result = diffWithTier("{oops", "{oops!", "broken.json", "broken.json");
    expect(result.tier).toBe(Tier.Data);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.type).toBe("Delete");
  });
});
