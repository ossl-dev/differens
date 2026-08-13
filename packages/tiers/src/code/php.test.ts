import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { PhpExtractor } from "./php";

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

describe("PhpExtractor", () => {
  const ex = new PhpExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("program")).toBe("file");
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("method_declaration")).toBe("Method");
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("namespace_definition")).toBe("Namespace");
    expect(ex.extractConcept("property_declaration")).toBe("Variable");
    expect(ex.extractConcept("function_call_expression")).toBe("CallExpression");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("integer")).toBe("integer_literal");
    expect(ex.extractConcept("boolean")).toBe("boolean_literal");
    expect(ex.extractConcept("null")).toBe("null_literal");
    expect(ex.extractConcept("foreach_statement")).toBe("ForLoop");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  it("parses a function and labels it", () => {
    const source = "<?php function parse_config(string $raw) { return $raw; }\n";
    const root = parseWith("tree-sitter-php", "php", source);
    const fn = root.namedChildren.find((c) => c.type === "function_definition")!;
    expect(ex.extractLabel(fn, source)).toBe("parse_config");
  });

  it("labels classes and properties via fallback", () => {
    const source = "<?php class Worker {}\n";
    const root = parseWith("tree-sitter-php", "php", source);
    const klass = root.namedChildren.find((c) => c.type === "class_declaration")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");

    const src2 = "<?php class W { public $count = 0; }\n";
    const root2 = parseWith("tree-sitter-php", "php", src2);
    const prop = findType(root2, "property_declaration")!;
    expect(ex.extractLabel(prop, src2)).toBe("$count");
  });

  it("lists its label fallback types", () => {
    expect(ex.labelFallbackTypes!.has("property_declaration")).toBe(true);
  });
});
