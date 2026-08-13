import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { CppExtractor } from "./cpp";

describe("CppExtractor", () => {
  const ex = new CppExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("translation_unit")).toBe("file");
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("class_specifier")).toBe("Class");
    expect(ex.extractConcept("struct_specifier")).toBe("Struct");
    expect(ex.extractConcept("namespace_definition")).toBe("Namespace");
    expect(ex.extractConcept("template_declaration")).toBe("TemplateDeclaration");
    expect(ex.extractConcept("template_parameter_list")).toBe("TypeParameters");
    expect(ex.extractConcept("type_parameter_declaration")).toBe("Parameter");
    expect(ex.extractConcept("parameter_list")).toBe("Parameters");
    expect(ex.extractConcept("declaration")).toBe("Variable");
    expect(ex.extractConcept("field_declaration")).toBe("Variable");
    expect(ex.extractConcept("access_specifier")).toBe("AccessSpecifier");
    expect(ex.extractConcept("conditional_expression")).toBe("TernaryOp");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("number_literal")).toBe("number_literal");
    expect(ex.extractConcept("qualified_identifier")).toBe("TypeIdentifier");
    expect(ex.extractConcept("identifier")).toBe("identifier");
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

    it("parses a function and labels it from the declarator chain", () => {
      const source = "namespace ns { int run() { return 1; } }";
      const root = parseWith("tree-sitter-cpp", undefined, source);
      const ns = root.namedChildren.find((c) => c.type === "namespace_definition")!;
      expect(ex.extractLabel(ns, source)).toBe("ns");
      const list = ns.namedChildren.find((c) => c.type === "declaration_list")!;
      const fn = list.namedChildren.find((c) => c.type === "function_definition")!;
      expect(ex.extractLabel(fn, source)).toBe("run");
    });

    it("labels variables via the declaration fallback", () => {
      const source = "int count = 0;";
      const root = parseWith("tree-sitter-cpp", undefined, source);
      const decl = root.namedChildren.find((c) => c.type === "declaration")!;
      expect(ex.extractLabel(decl, source)).toBe("count");
    });

    it("labels classes and method prototypes via the field fallback", () => {
      const source = "class Worker { public: int run(); };";
      const root = parseWith("tree-sitter-cpp", undefined, source);
      const cls = root.namedChildren.find((c) => c.type === "class_specifier")!;
      expect(ex.extractLabel(cls, source)).toBe("Worker");
      const body = cls.namedChildren.find((c) => c.type === "field_declaration_list")!;
      const method = body.namedChildren.find((c) => c.type === "field_declaration")!;
      expect(ex.extractLabel(method, source)).toBe("run");
    });

    it("declares the fallback label types", () => {
      for (const t of ["function_definition", "declaration", "field_declaration"]) {
        expect(ex.labelFallbackTypes!.has(t)).toBe(true);
      }
    });
  });
});
