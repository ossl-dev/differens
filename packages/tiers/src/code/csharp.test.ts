import { describe, expect, it } from "bun:test";
import type Parser from "tree-sitter";
import { CSharpExtractor } from "./csharp";
import { loadLanguage } from "./index";

describe("CSharpExtractor", () => {
  const ex = new CSharpExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("method_declaration")).toBe("Method");
    expect(ex.extractConcept("namespace_declaration")).toBe("Namespace");
    expect(ex.extractConcept("using_directive")).toBe("Import");
    expect(ex.extractConcept("field_declaration")).toBe("FieldDecl");
    expect(ex.extractConcept("variable_declaration")).toBe("Variable");
    expect(ex.extractConcept("parameter")).toBe("Parameter");
    expect(ex.extractConcept("parameter_list")).toBe("Parameters");
    expect(ex.extractConcept("return_statement")).toBe("Return");
    expect(ex.extractConcept("invocation_expression")).toBe("CallExpression");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("integer_literal")).toBe("integer_literal");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  // tree-sitter-c-sharp ships only an ESM wrapper (top-level await), so
  // require() cannot load it; loadLanguage uses the repo's dlopen path.
  function parseCSharp(source: string): Parser.SyntaxNode {
    const lang = loadLanguage("cs")!;
    return lang.parser.parse(source).rootNode;
  }

  it("parses a class and labels it from the name field", () => {
    const source = "class Worker { int Run(int n) { return n; } }";
    const root = parseCSharp(source);
    const klass = root.namedChildren.find((c) => c.type === "class_declaration")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");
  });

  it("parses a method and labels it from the name field", () => {
    const source = "class Worker { int Run(int n) { return n; } }";
    const root = parseCSharp(source);
    const method = root.descendantsOfType("method_declaration")[0]!;
    expect(ex.extractLabel(method, source)).toBe("Run");
  });

  it("labels fields via the declarator fallback", () => {
    const source = "class Worker { int value; }";
    const root = parseCSharp(source);
    const field = root.descendantsOfType("field_declaration")[0]!;
    expect(ex.extractLabel(field, source)).toBe("value");
  });

  it("labels local variables via the declarator fallback", () => {
    const source = "class Worker { void Run() { int count = 5; } }";
    const root = parseCSharp(source);
    const decl = root.descendantsOfType("variable_declaration")[0]!;
    expect(ex.extractLabel(decl, source)).toBe("count");
  });

  it("declares fallback types for declarations without a name field", () => {
    expect(ex.labelFallbackTypes!.has("variable_declaration")).toBe(true);
    expect(ex.labelFallbackTypes!.has("field_declaration")).toBe(true);
  });
});
