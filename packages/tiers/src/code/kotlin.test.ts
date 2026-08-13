import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { KotlinExtractor } from "./kotlin";

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

describe("KotlinExtractor", () => {
  const ex = new KotlinExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("source_file")).toBe("file");
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("function_declaration")).toBe("Function");
    expect(ex.extractConcept("property_declaration")).toBe("Variable");
    expect(ex.extractConcept("type_alias")).toBe("TypeDef");
    expect(ex.extractConcept("import_header")).toBe("Import");
    expect(ex.extractConcept("package_header")).toBe("Namespace");
    expect(ex.extractConcept("call_expression")).toBe("CallExpression");
    expect(ex.extractConcept("additive_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("integer_literal")).toBe("integer_literal");
    expect(ex.extractConcept("real_literal")).toBe("float_literal");
    expect(ex.extractConcept("boolean_literal")).toBe("boolean_literal");
    expect(ex.extractConcept("when_expression")).toBe("SwitchBlock");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  it("parses a function and labels it", () => {
    const source = "fun parse_config(raw: String) = raw\n";
    const root = parseWith("tree-sitter-kotlin", undefined, source);
    const fn = root.namedChildren.find((c) => c.type === "function_declaration")!;
    expect(ex.extractLabel(fn, source)).toBe("parse_config");
  });

  it("labels classes, variables, and parameters via fallback", () => {
    const source = "class Worker {}\n";
    const root = parseWith("tree-sitter-kotlin", undefined, source);
    const klass = root.namedChildren.find((c) => c.type === "class_declaration")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");

    const src2 = "val count = 0\n";
    const root2 = parseWith("tree-sitter-kotlin", undefined, src2);
    const prop = root2.namedChildren.find((c) => c.type === "property_declaration")!;
    expect(ex.extractLabel(prop, src2)).toBe("count");
    const variable = findType(root2, "variable_declaration")!;
    expect(ex.extractLabel(variable, src2)).toBe("count");

    const src3 = "typealias Id = Long\n";
    const root3 = parseWith("tree-sitter-kotlin", undefined, src3);
    const alias = root3.namedChildren.find((c) => c.type === "type_alias")!;
    expect(ex.extractLabel(alias, src3)).toBe("Id");

    const src4 = "fun greet(other: String) {}\n";
    const root4 = parseWith("tree-sitter-kotlin", undefined, src4);
    const param = findType(root4, "parameter")!;
    expect(ex.extractLabel(param, src4)).toBe("other");
  });

  it("lists its label fallback types", () => {
    for (const type of [
      "class_declaration",
      "function_declaration",
      "property_declaration",
      "variable_declaration",
      "type_alias",
      "parameter",
      "class_parameter",
      "enum_entry",
    ]) {
      expect(ex.labelFallbackTypes!.has(type)).toBe(true);
    }
  });
});
