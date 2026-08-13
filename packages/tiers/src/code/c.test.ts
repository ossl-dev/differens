import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { CExtractor } from "./c";

describe("CExtractor", () => {
  const ex = new CExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("translation_unit")).toBe("file");
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("struct_specifier")).toBe("Struct");
    expect(ex.extractConcept("union_specifier")).toBe("Union");
    expect(ex.extractConcept("enum_specifier")).toBe("Enum");
    expect(ex.extractConcept("declaration")).toBe("Variable");
    expect(ex.extractConcept("field_declaration")).toBe("Variable");
    expect(ex.extractConcept("parameter_list")).toBe("Parameters");
    expect(ex.extractConcept("compound_statement")).toBe("Block");
    expect(ex.extractConcept("return_statement")).toBe("Return");
    expect(ex.extractConcept("if_statement")).toBe("IfBlock");
    expect(ex.extractConcept("preproc_include")).toBe("PreprocInclude");
    expect(ex.extractConcept("storage_class_specifier")).toBe("StorageClass");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("number_literal")).toBe("number_literal");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("primitive_type")).toBe("TypeIdentifier");
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
      const source = "int add(int a, int b) { return a + b; }";
      const root = parseWith("tree-sitter-c", undefined, source);
      const fn = root.namedChildren.find((c) => c.type === "function_definition")!;
      expect(ex.extractLabel(fn, source)).toBe("add");
    });

    it("labels variables via the declaration fallback", () => {
      const source = "static int count = 0;";
      const root = parseWith("tree-sitter-c", undefined, source);
      const decl = root.namedChildren.find((c) => c.type === "declaration")!;
      expect(ex.extractLabel(decl, source)).toBe("count");
    });

    it("labels structs from the name field and fields via fallback", () => {
      const source = "struct Point { int x; int y; };";
      const root = parseWith("tree-sitter-c", undefined, source);
      const struct = root.namedChildren.find((c) => c.type === "struct_specifier")!;
      expect(ex.extractLabel(struct, source)).toBe("Point");
      const list = struct.namedChildren.find((c) => c.type === "field_declaration_list")!;
      const field = list.namedChildren.find((c) => c.type === "field_declaration")!;
      expect(ex.extractLabel(field, source)).toBe("x");
    });

    it("declares the fallback label types", () => {
      for (const t of ["function_definition", "declaration", "field_declaration"]) {
        expect(ex.labelFallbackTypes!.has(t)).toBe(true);
      }
    });
  });
});
