import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { RubyExtractor } from "./ruby";

const require = createRequire(import.meta.url);

function parseWith(module: string, pick: string | undefined, source: string): Parser.SyntaxNode {
  const mod = require(module) as Record<string, unknown>;
  const grammar = (pick ? mod[pick] : (mod.language ?? mod)) as Parser.Language;
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser.parse(source).rootNode;
}

describe("RubyExtractor", () => {
  const ex = new RubyExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("program")).toBe("file");
    expect(ex.extractConcept("class")).toBe("Class");
    expect(ex.extractConcept("module")).toBe("Module");
    expect(ex.extractConcept("method")).toBe("Method");
    expect(ex.extractConcept("call")).toBe("CallExpression");
    expect(ex.extractConcept("assignment")).toBe("Assignment");
    expect(ex.extractConcept("instance_variable")).toBe("Variable");
    expect(ex.extractConcept("constant")).toBe("Constant");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("integer")).toBe("integer_literal");
    expect(ex.extractConcept("simple_symbol")).toBe("Symbol");
    expect(ex.extractConcept("if_modifier")).toBe("IfBlock");
    expect(ex.extractConcept("comment")).toBe("Comment");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  it("parses a function and labels it", () => {
    const source = "def parse_config(raw)\n  raw\nend\n";
    const root = parseWith("tree-sitter-ruby", undefined, source);
    const method = root.namedChildren.find((c) => c.type === "method")!;
    expect(ex.extractLabel(method, source)).toBe("parse_config");
  });

  it("labels classes and instance variables via fallback", () => {
    const source = "class Worker\nend\n";
    const root = parseWith("tree-sitter-ruby", undefined, source);
    const klass = root.namedChildren.find((c) => c.type === "class")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");

    const src2 = "@name = 1\n";
    const root2 = parseWith("tree-sitter-ruby", undefined, src2);
    const assignment = root2.namedChildren.find((c) => c.type === "assignment")!;
    const variable = assignment.childForFieldName("left")!;
    expect(variable.type).toBe("instance_variable");
    expect(ex.extractLabel(variable, src2)).toBe("@name");
  });

  it("lists its label fallback types", () => {
    expect(ex.labelFallbackTypes!.has("instance_variable")).toBe(true);
  });
});
