import { describe, expect, it } from "bun:test";
import type Parser from "tree-sitter";
import { loadLanguage } from "./index";
import { LuaExtractor } from "./lua";

describe("LuaExtractor", () => {
  const ex = new LuaExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("chunk")).toBe("file");
    expect(ex.extractConcept("function_declaration")).toBe("Function");
    expect(ex.extractConcept("variable_declaration")).toBe("Variable");
    expect(ex.extractConcept("assignment_statement")).toBe("Assignment");
    expect(ex.extractConcept("table_constructor")).toBe("ObjectLiteral");
    expect(ex.extractConcept("field")).toBe("KeyValuePair");
    expect(ex.extractConcept("function_call")).toBe("CallExpression");
    expect(ex.extractConcept("binary_expression")).toBe("BinaryOp");
    expect(ex.extractConcept("if_statement")).toBe("IfBlock");
    expect(ex.extractConcept("while_statement")).toBe("WhileLoop");
    expect(ex.extractConcept("number")).toBe("number_literal");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("nil")).toBe("null_literal");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  // @tree-sitter-grammars/tree-sitter-lua ships only an ESM wrapper
  // (top-level await), so require() cannot load it; loadLanguage uses the
  // repo's dlopen path.
  function parseLua(source: string): Parser.SyntaxNode {
    const lang = loadLanguage("lua")!;
    return lang.parser.parse(source).rootNode;
  }

  it("parses a function and labels it from the name field", () => {
    const source = "function increment(step) return step end";
    const root = parseLua(source);
    const fn = root.namedChildren.find((c) => c.type === "function_declaration")!;
    expect(ex.extractLabel(fn, source)).toBe("increment");
  });

  it("labels local variables via the local-declaration fallback", () => {
    const source = "local x = 5";
    const root = parseLua(source);
    const decl = root.namedChildren.find((c) => c.type === "variable_declaration")!;
    expect(ex.extractLabel(decl, source)).toBe("x");
  });

  it("labels locals nested inside a function body", () => {
    const source = "function increment(step) local total = 0; return total end";
    const root = parseLua(source);
    const decl = root.descendantsOfType("variable_declaration")[0]!;
    expect(ex.extractLabel(decl, source)).toBe("total");
  });

  it("declares the fallback type for local declarations", () => {
    expect(ex.labelFallbackTypes!.has("variable_declaration")).toBe(true);
  });
});
