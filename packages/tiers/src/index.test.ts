import { describe, expect, it } from "bun:test";
import { classifyFile, Tier, parseData, diffWithTier } from "./index";
// parseMarkup / diffLines / diffWords are not re-exported from the
// package index, so they are imported from their adapter modules.
import { parseMarkup } from "./markup";
import { diffLines } from "./raw";
import { diffWords } from "./prose";
import type { Node } from "@differens/core";

describe("classifyFile", () => {
  it("classifies JSON as Data tier", () => {
    const info = classifyFile("config.json");
    expect(info.tier).toBe(Tier.Data);
  });

  it("classifies TypeScript as Code tier", () => {
    const info = classifyFile("app.ts");
    expect(info.tier).toBe(Tier.Code);
  });

  it("classifies HTML as Markup tier", () => {
    const info = classifyFile("index.html");
    expect(info.tier).toBe(Tier.Markup);
  });

  it("classifies PNG as Binary tier", () => {
    const info = classifyFile("logo.png");
    expect(info.tier).toBe(Tier.Binary);
  });

  it("classifies TXT as Prose tier", () => {
    const info = classifyFile("readme.txt");
    expect(info.tier).toBe(Tier.Prose);
  });

  it("classifies unknown extension as Raw tier", () => {
    const info = classifyFile("data.xyz");
    expect(info.tier).toBe(Tier.Raw);
  });
});

// ============================================================
// Edge case tests
// ============================================================

/** Depth-first search for the first node with the given label. */
function findNode(node: Node, label: string): Node | undefined {
  if (node.label === label) return node;
  for (const child of node.children) {
    const found = findNode(child, label);
    if (found) return found;
  }
  return undefined;
}

describe("parseData edge cases", () => {
  it("handles empty string input", () => {
    const node = parseData("");
    expect(node.kind).toBe("leaf");
    expect(node.value).toBe("");
  });

  it("handles whitespace-only input", () => {
    const node = parseData("   \n\t ");
    expect(node.kind).toBe("leaf");
    expect(node.value).toBe("");
  });

  it("does not throw on malformed JSON (missing closing brace)", () => {
    // JSON.parse fails; the YAML subset parser then picks up the remains.
    expect(() => parseData('{"name": "alice"')).not.toThrow();
    const node = parseData('{"name": "alice"');
    expect(node.kind).toBe("object");
    expect(findNode(node, '{"name"')?.value).toBe("alice");
  });

  it("does not throw on malformed JSON (trailing comma)", () => {
    expect(() => parseData('{"a": 1,}')).not.toThrow();
    const node = parseData('{"a": 1,}');
    expect(node.kind).toBe("object");
    // The "1,}" remainder is kept as a string by the YAML subset parser.
    expect(findNode(node, '{"a"')?.value).toBe("1,}");
  });

  it("does not throw on an unclosed JSON array", () => {
    // JSON fails and there is no ":" for YAML, so the TOML subset sees
    // a line with no key/value pair and returns an empty object.
    expect(() => parseData("[1, 2,")).not.toThrow();
    const node = parseData("[1, 2,");
    expect(node.kind).toBe("object");
    expect(node.children.length).toBe(0);
  });
});

describe("parseData YAML edge cases", () => {
  it("parses YAML with 4-space indentation at the top level", () => {
    const node = parseData(
      ["name: test", "database:", "    host: localhost", "    port: 5432"].join("\n"),
    );
    expect(node.kind).toBe("object");
    expect(findNode(node, "name")?.value).toBe("test");
    // The subset parser assumes 2-space nesting, so 4-space children
    // are skipped and the parent becomes an empty object.
    const database = findNode(node, "database");
    expect(database?.kind).toBe("object");
    expect(database?.children.length).toBe(0);
    expect(findNode(node, "host")).toBeUndefined();
  });

  it("parses a nested sequence of scalars", () => {
    const node = parseData("servers:\n  - alpha\n  - beta");
    expect(node.kind).toBe("object");
    expect(findNode(node, "servers")?.kind).toBe("array");
    expect(findNode(node, "servers[0]")?.value).toBe("alpha");
    expect(findNode(node, "servers[1]")?.value).toBe("beta");
  });

  it("parses nested sequences with mixed scalar types", () => {
    const node = parseData("ports:\n  - 80\n  - 443\nflags:\n  - true\n  - false");
    expect(node.kind).toBe("object");
    expect(findNode(node, "ports[0]")?.value).toBe("80");
    expect(findNode(node, "ports[1]")?.value).toBe("443");
    expect(findNode(node, "flags[0]")?.value).toBe("true");
    expect(findNode(node, "flags[1]")?.value).toBe("false");
  });

  it("flattens sequences nested under sequence items to scalars", () => {
    // Deeply nested sequences are outside the supported subset: the
    // first "- - a" item becomes the scalar "- a", and the deeper
    // "- b" item is absorbed into the same array as "b".
    const node = parseData("matrix:\n  - - a\n    - b");
    expect(node.kind).toBe("object");
    expect(findNode(node, "matrix[0]")?.value).toBe("- a");
    expect(findNode(node, "matrix[1]")?.value).toBe("b");
  });
});

describe("parseData TOML edge cases", () => {
  it("parses dotted section headers like [database.pool]", () => {
    const node = parseData(
      ['[database]', 'host = "localhost"', "", "[database.pool]", "max = 10", "min = 2"].join("\n"),
    );
    expect(node.kind).toBe("object");
    expect(findNode(node, "host")?.value).toBe("localhost");
    expect(findNode(node, "pool")?.kind).toBe("object");
    expect(findNode(node, "max")?.value).toBe("10");
    expect(findNode(node, "min")?.value).toBe("2");
  });

  it("creates intermediate sections for deep dotted headers", () => {
    const node = parseData("[a.b.c]\nenabled = true");
    expect(node.kind).toBe("object");
    expect(findNode(node, "a")?.kind).toBe("object");
    expect(findNode(node, "b")?.kind).toBe("object");
    expect(findNode(node, "enabled")?.value).toBe("true");
  });
});

describe("parseMarkup edge cases", () => {
  it("tolerates unclosed tags", () => {
    const root = parseMarkup("<div><p>hello");
    const div = root.children[0]!;
    expect(div.tag).toBe("div");
    const p = div.children[0]!;
    expect(p.tag).toBe("p");
    expect(p.text).toBe("hello");
  });

  it("handles repeated open tags without closing them", () => {
    const root = parseMarkup("<ul><li>one<li>two</ul>");
    const ul = root.children[0]!;
    expect(ul.tag).toBe("ul");
    // The first <li> is never closed, so the second <li> nests inside it.
    expect(ul.children.length).toBe(1);
    const li = ul.children[0]!;
    expect(li.tag).toBe("li");
    expect(li.text).toBe("one");
    expect(li.children[0]?.tag).toBe("li");
    expect(li.children[0]?.text).toBe("two");
  });

  it("treats a DOCTYPE declaration as text, not a tag", () => {
    const root = parseMarkup("<!DOCTYPE html><html><body>hi</body></html>");
    expect(root.text).toBe("<!DOCTYPE html>");
    const html = root.children[0]!;
    expect(html.tag).toBe("html");
    const body = html.children[0]!;
    expect(body.tag).toBe("body");
    expect(body.text).toBe("hi");
  });

  it("handles self-closing <br/> and void <br> tags", () => {
    const root = parseMarkup("<p>line1<br/>line2<br>end</p>");
    const p = root.children[0]!;
    expect(p.tag).toBe("p");
    expect(p.children.length).toBe(2);
    expect(p.children[0]?.tag).toBe("br");
    expect(p.children[1]?.tag).toBe("br");
    // Text on both sides of the breaks accumulates on the parent.
    expect(p.text).toBe("line1line2end");
  });

  it("parses a standalone self-closing tag", () => {
    const root = parseMarkup("<br/>");
    expect(root.children[0]?.tag).toBe("br");
    expect(root.children[0]?.children.length).toBe(0);
  });

  it("parses attributes on self-closing tags", () => {
    const root = parseMarkup('<img src="logo.png" alt="logo" />');
    const img = root.children[0]!;
    expect(img.tag).toBe("img");
    expect(img.attrs?.src).toBe("logo.png");
    expect(img.attrs?.alt).toBe("logo");
  });
});

describe("diffWords edge cases", () => {
  it("detects whitespace-only changes as an update", () => {
    const hunks = diffWords("hello world", "hello  world");
    expect(hunks.length).toBe(1);
    expect(hunks[0]?.type).toBe("Update");
    expect(hunks[0]?.oldText).toBe(" ");
    expect(hunks[0]?.newText).toBe("  ");
  });

  it("detects a trailing newline insert", () => {
    const hunks = diffWords("a\nb", "a\nb\n");
    expect(hunks.length).toBe(1);
    expect(hunks[0]?.type).toBe("Insert");
    expect(hunks[0]?.text).toBe("\n");
  });

  it("returns no hunks for identical text", () => {
    expect(diffWords("hello world", "hello world")).toEqual([]);
  });

  it("returns no changes for identical prose through diffWithTier", () => {
    const result = diffWithTier("same text", "same text", "note.txt", "note.txt");
    expect(result.tier).toBe(Tier.Prose);
    expect(result.changes).toEqual([]);
  });

  it("routes whitespace-only changes through the prose tier", () => {
    const result = diffWithTier("hello world", "hello  world", "note.txt", "note.txt");
    expect(result.tier).toBe(Tier.Prose);
    expect(result.changes.length).toBe(1);
    const change = result.changes[0]!;
    expect(change.type).toBe("Update");
    if (change.type === "Update") {
      expect(change.detail).toEqual({
        kind: "ValueChanged",
        from: " ",
        to: "  ",
      });
    }
  });
});

describe("diffLines edge cases", () => {
  it("diffs completely different files as deletes, an update, then inserts", () => {
    const hunks = diffLines("alpha\nbeta\ngamma", "one\ntwo\nthree");
    // No lines match, so all old lines delete and all new lines insert;
    // the adjacent delete/insert pair (gamma -> one) merges into an update.
    expect(hunks.length).toBe(5);
    expect(hunks[0]).toEqual({ type: "Delete", text: "alpha" });
    expect(hunks[1]).toEqual({ type: "Delete", text: "beta" });
    expect(hunks[2]).toEqual({
      type: "Update",
      text: "one",
      oldText: "gamma",
      newText: "one",
    });
    expect(hunks[3]).toEqual({ type: "Insert", text: "two" });
    expect(hunks[4]).toEqual({ type: "Insert", text: "three" });
  });

  it("routes completely different files through the raw tier", () => {
    const result = diffWithTier("alpha\nbeta\ngamma", "one\ntwo\nthree", "data.xyz", "data.xyz");
    expect(result.tier).toBe(Tier.Raw);
    expect(result.changes.length).toBe(5);
  });
});

describe("classifyFile edge cases", () => {
  it("classifies a file with no extension as Raw tier", () => {
    const info = classifyFile("Makefile");
    expect(info.tier).toBe(Tier.Raw);
    expect(info.extension).toBe("makefile");
  });

  it("classifies no-extension names ending in known prose names", () => {
    expect(classifyFile("README").tier).toBe(Tier.Prose);
    expect(classifyFile("LICENSE").tier).toBe(Tier.Prose);
  });

  it("classifies uppercase extensions case-insensitively", () => {
    expect(classifyFile("CONFIG.JSON").tier).toBe(Tier.Data);
    expect(classifyFile("INDEX.HTML").tier).toBe(Tier.Markup);
    expect(classifyFile("LOGO.PNG").tier).toBe(Tier.Binary);
    expect(classifyFile("App.Ts").tier).toBe(Tier.Code);
  });
});

describe("diffWithTier fallback behavior", () => {
  it("diffs code files without a grammar at line level instead of crashing", () => {
    // "java" is a Code-tier extension with no registered tree-sitter
    // grammar, so parseCode degrades to a line-based file node.
    const result = diffWithTier(
      "public class A {}",
      "public class B {}",
      "Main.java",
      "Main.java",
    );
    expect(result.tier).toBe(Tier.Code);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("tolerates malformed HTML instead of crashing", () => {
    // parseMarkup is a lenient tokenizer: unclosed tags never throw,
    // so the markup tier handles the diff without falling back to raw.
    const result = diffWithTier(
      "<div><p>unclosed",
      "<div><p>closed</p></div>",
      "page.html",
      "page.html",
    );
    expect(result.tier).toBe(Tier.Markup);
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

describe("diffLines on large inputs", () => {
  const lines = (n: number, changed = -1) =>
    Array.from({ length: n }, (_, i) => (i === changed ? "CHANGED" : `line ${i}`)).join("\n");

  it("isolates one changed line in a 50k-line file", () => {
    // The LCS table is O(n*m). Without trimming the identical head and tail
    // this allocated 200MB, so the tier gave up and reported the whole file.
    const diffs = diffLines(lines(50_000), lines(50_000, 25_000));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.newText).toBe("CHANGED");
  });

  it("reports nothing for two identical large files", () => {
    expect(diffLines(lines(50_000), lines(50_000))).toEqual([]);
  });
});
