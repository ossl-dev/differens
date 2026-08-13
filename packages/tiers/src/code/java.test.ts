import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { JavaExtractor } from "./java";

describe("JavaExtractor", () => {
  const ex = new JavaExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("program")).toBe("file");
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("interface_declaration")).toBe("Interface");
    expect(ex.extractConcept("enum_declaration")).toBe("Enum");
    expect(ex.extractConcept("method_declaration")).toBe("Method");
    expect(ex.extractConcept("package_declaration")).toBe("Namespace");
    expect(ex.extractConcept("import_declaration")).toBe("Import");
    expect(ex.extractConcept("local_variable_declaration")).toBe("Variable");
    expect(ex.extractConcept("field_declaration")).toBe("Variable");
    expect(ex.extractConcept("formal_parameters")).toBe("Parameters");
    expect(ex.extractConcept("block")).toBe("Block");
    expect(ex.extractConcept("if_statement")).toBe("IfBlock");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("decimal_integer_literal")).toBe("integer_literal");
    expect(ex.extractConcept("true")).toBe("boolean_literal");
    expect(ex.extractConcept("null_literal")).toBe("null_literal");
    expect(ex.extractConcept("method_invocation")).toBe("CallExpression");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("update_expression")).toBe("UnaryOp");
    expect(ex.extractConcept("parenthesized_expression")).toBe("Parenthesized");
    expect(ex.extractConcept("expression_statement")).toBe("Expression");
    expect(ex.extractConcept("scoped_identifier")).toBe("Namespace");
    expect(ex.extractConcept("modifiers")).toBe("Modifier");
    expect(ex.extractConcept("identifier")).toBe("identifier");
    expect(ex.extractConcept("type_identifier")).toBe("TypeIdentifier");
    expect(ex.extractConcept("integral_type")).toBe("TypeIdentifier");
    expect(ex.extractConcept("void_type")).toBe("TypeIdentifier");
    expect(ex.extractConcept("comment")).toBe("Comment");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  describe("extractor label rules", () => {
    const require = createRequire(import.meta.url);

    function parseWith(
      module: string,
      pick: string | undefined,
      source: string,
    ): Parser.SyntaxNode {
      const mod = require(module) as Record<string, unknown>;
      const grammar = (pick ? mod[pick] : (mod.language ?? mod)) as Parser.Language;
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser.parse(source).rootNode;
    }

    it("parses a method and labels it from the name field", () => {
      const source = "class Worker { void run() {} }";
      const root = parseWith("tree-sitter-java", undefined, source);
      const classDecl = root.namedChildren.find((c) => c.type === "class_declaration")!;
      const body = classDecl.namedChildren.find((c) => c.type === "class_body")!;
      const method = body.namedChildren.find((c) => c.type === "method_declaration")!;
      expect(ex.extractLabel(method, source)).toBe("run");
    });

    it("labels local variables via the declaration fallback", () => {
      const source = "class Worker { void run() { int count = 0; } }";
      const root = parseWith("tree-sitter-java", undefined, source);
      const classDecl = root.namedChildren.find((c) => c.type === "class_declaration")!;
      const body = classDecl.namedChildren.find((c) => c.type === "class_body")!;
      const method = body.namedChildren.find((c) => c.type === "method_declaration")!;
      const block = method.namedChildren.find((c) => c.type === "block")!;
      const decl = block.namedChildren.find((c) => c.type === "local_variable_declaration")!;
      expect(ex.extractLabel(decl, source)).toBe("count");
    });

    it("labels fields via the declaration fallback", () => {
      const source = "class Point { int x; }";
      const root = parseWith("tree-sitter-java", undefined, source);
      const classDecl = root.namedChildren.find((c) => c.type === "class_declaration")!;
      const body = classDecl.namedChildren.find((c) => c.type === "class_body")!;
      const field = body.namedChildren.find((c) => c.type === "field_declaration")!;
      expect(ex.extractLabel(field, source)).toBe("x");
    });

    it("declares the fallback label types", () => {
      for (const t of ["local_variable_declaration", "field_declaration"]) {
        expect(ex.labelFallbackTypes!.has(t)).toBe(true);
      }
    });
  });
});
