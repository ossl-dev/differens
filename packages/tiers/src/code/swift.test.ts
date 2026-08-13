import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { SwiftExtractor } from "./swift";

const require = createRequire(import.meta.url);

function parseWith(module: string, pick: string | undefined, source: string): Parser.SyntaxNode {
  const mod = require(module) as Record<string, unknown>;
  const grammar = (pick ? mod[pick] : (mod.language ?? mod)) as Parser.Language;
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser.parse(source).rootNode;
}

function findType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findType(child, type);
    if (found) return found;
  }
  return undefined;
}

describe("SwiftExtractor", () => {
  const ex = new SwiftExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("source_file")).toBe("file");
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("protocol_declaration")).toBe("Interface");
    expect(ex.extractConcept("function_declaration")).toBe("Function");
    expect(ex.extractConcept("property_declaration")).toBe("Variable");
    expect(ex.extractConcept("import_declaration")).toBe("Import");
    expect(ex.extractConcept("call_expression")).toBe("CallExpression");
    expect(ex.extractConcept("comparison_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("integer_literal")).toBe("integer_literal");
    expect(ex.extractConcept("real_literal")).toBe("float_literal");
    expect(ex.extractConcept("boolean_literal")).toBe("boolean_literal");
    expect(ex.extractConcept("line_string_literal")).toBe("string_literal");
    expect(ex.extractConcept("enum_entry")).toBe("Enum");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  it("parses a function and labels it", () => {
    const source = "func parse_config(raw: String) -> Int { return 1 }\n";
    const root = parseWith("tree-sitter-swift", undefined, source);
    const fn = root.namedChildren.find((c) => c.type === "function_declaration")!;
    expect(ex.extractLabel(fn, source)).toBe("parse_config");
  });

  it("labels classes, properties, and enum entries", () => {
    const source = "class Worker {}\n";
    const root = parseWith("tree-sitter-swift", undefined, source);
    const klass = root.namedChildren.find((c) => c.type === "class_declaration")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");

    const src2 = "class W {\n  var count = 0\n}\n";
    const root2 = parseWith("tree-sitter-swift", undefined, src2);
    const prop = findType(root2, "property_declaration")!;
    expect(ex.extractLabel(prop, src2)).toBe("count");

    const src3 = "enum E {\n  case idle\n}\n";
    const root3 = parseWith("tree-sitter-swift", undefined, src3);
    const entry = findType(root3, "enum_entry")!;
    expect(ex.extractLabel(entry, src3)).toBe("idle");
  });

  it("lists its label fallback types", () => {
    expect(ex.labelFallbackTypes!.has("property_declaration")).toBe(true);
  });
});
