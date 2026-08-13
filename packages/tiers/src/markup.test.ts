import { describe, expect, it } from "bun:test";
import { parseMarkup } from "./markup";

describe("parseMarkup: whitespace and comments", () => {
  it("attaches inter-tag whitespace as text", () => {
    const root = parseMarkup("<p>hello</p>\n  <p>world</p>");
    expect(root.children).toHaveLength(2);
  });

  it("appends whitespace to an existing text run", () => {
    // Text set before any child lands on the parent, and later whitespace
    // and text runs append to it.
    const root = parseMarkup("hello <p>world</p> tail");
    expect(root.text).toBe("hello  tail");
  });

  it("skips comments entirely", () => {
    const root = parseMarkup("<!-- a comment --><p>x</p><!-- another -->");
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.tag).toBe("p");
  });

  it("stops cleanly on an unterminated comment", () => {
    const root = parseMarkup("<p>x</p><!-- never closed");
    expect(root.children).toHaveLength(1);
  });
});

describe("parseMarkup: void elements", () => {
  it("treats void elements as self-closing without pushing the stack", () => {
    const root = parseMarkup('<div><img src="a.png"><br>text</div>');
    const div = root.children[0]!;
    expect(div.children.map((c) => c.tag)).toEqual(["img", "br"]);
    expect(div.text).toBe("text");
  });
});

describe("parseMarkup: malformed input", () => {
  it("never throws on a bare > inside an attribute value", () => {
    // Known limitation: the tokenizer ends the attribute at the >, but the
    // parse must survive and keep producing a tree.
    const root = parseMarkup('<div title="a > b">x</div>');
    const div = root.children.find((c) => c.tag === "div");
    expect(div).toBeDefined();
  });

  it("never throws on misnested tags", () => {
    const root = parseMarkup("<b><i>x</b></i>");
    expect(root.children.length).toBeGreaterThan(0);
  });

  it("never throws on a stray closing tag", () => {
    const root = parseMarkup("</div><p>x</p>");
    expect(root.children[0]!.tag).toBe("p");
  });

  it("never throws on a bare < with no tag", () => {
    const root = parseMarkup("3 < 4 and < 5");
    expect(root.text).toContain("3 < 4");
  });
});

describe("parseMarkup: attributes", () => {
  it("parses bare attributes as present with undefined value", () => {
    const root = parseMarkup("<input disabled>");
    const input = root.children[0]!;
    expect(input.attrs?.disabled).toBeUndefined();
    expect("disabled" in (input.attrs ?? {})).toBe(true);
  });

  it("captures id and class", () => {
    const root = parseMarkup('<div id="main" class="a b">x</div>');
    const div = root.children[0]!;
    expect(div.attrs?.id).toBe("main");
    expect(div.attrs?.class).toBe("a b");
  });
});
