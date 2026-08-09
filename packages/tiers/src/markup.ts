/**
 * Tier 3  --  Markup adapter (HTML, XML, SVG).
 *
 * Parses markup into a DOM-like element tree.
 * Uses a lightweight tokenizer  --  no full HTML parser dependency.
 * Handles well-formed XML/HTML; malformed input falls back to T1.
 */

export interface MarkupAttrs {
  id?: string;
  class?: string;
  [key: string]: string | undefined;
}

export interface MarkupNode {
  tag: string;
  attrs?: MarkupAttrs;
  text?: string;
  children: MarkupNode[];
}

/**
 * Parse markup string into a tree of MarkupNodes.
 * This is a simple tokenizer that handles well-formed XML/HTML.
 */
export function parseMarkup(source: string): MarkupNode {
  const root: MarkupNode = { tag: "document", children: [] };
  const stack: MarkupNode[] = [root];
  let pos = 0;

  while (pos < source.length) {
    // Skip whitespace between tags
    const wsMatch = /^\s+/.exec(source.slice(pos));
    if (wsMatch) {
      const ws = wsMatch[0];
      // Attach whitespace as text to the current parent
      if (ws.trim() && stack.length > 0) {
        const parent = stack[stack.length - 1]!;
        if (parent.text) {
          parent.text += ws;
        } else if (parent.children.length === 0) {
          parent.text = ws;
        }
      }
      pos += ws.length;
      continue;
    }

    // Comment
    if (source.slice(pos, pos + 4) === "<!--") {
      const end = source.indexOf("-->", pos + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }

    // Closing tag
    const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)>/.exec(source.slice(pos));
    if (closeMatch) {
      if (stack.length > 1) stack.pop();
      pos += closeMatch[0].length;
      continue;
    }

    // Self-closing tag
    const selfCloseMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)\/>/.exec(source.slice(pos));
    if (selfCloseMatch) {
      const tag = selfCloseMatch[1]!;
      const attrs = parseAttrs(selfCloseMatch[2]!);
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push({ tag, attrs, children: [] });
      }
      pos += selfCloseMatch[0].length;
      continue;
    }

    // Opening tag
    const openMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)>/.exec(source.slice(pos));
    if (openMatch) {
      const tag = openMatch[1]!;
      const attrs = parseAttrs(openMatch[2]!);

      // Void elements (self-closing in HTML)
      const voidElements = new Set([
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
      ]);

      if (voidElements.has(tag.toLowerCase())) {
        if (stack.length > 0) {
          stack[stack.length - 1]!.children.push({ tag, attrs, children: [] });
        }
      } else {
        const node: MarkupNode = { tag, attrs, children: [] };
        if (stack.length > 0) {
          stack[stack.length - 1]!.children.push(node);
        }
        stack.push(node);
      }
      pos += openMatch[0].length;
      continue;
    }

    // Text content
    const textEnd = source.indexOf("<", pos);
    let text: string;
    if (textEnd === -1) {
      text = source.slice(pos);
      pos = source.length;
    } else if (textEnd === pos) {
      // No regex match and no text  --  advance to avoid infinite loop
      text = source.slice(pos, pos + 1);
      pos += 1;
    } else {
      text = source.slice(pos, textEnd);
      pos = textEnd;
    }

    if (text && stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      if (parent.text) {
        parent.text += text;
      } else {
        parent.text = text;
      }
    }
  }

  return root;
}

function parseAttrs(attrStr: string): MarkupAttrs {
  const attrs: MarkupAttrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]!] = m[2];
  }
  return attrs;
}
