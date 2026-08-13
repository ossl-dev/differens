import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { ScalaExtractor } from "./scala";

describe("ScalaExtractor", () => {
  const ex = new ScalaExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("class_definition")).toBe("Class");
    expect(ex.extractConcept("trait_definition")).toBe("Trait");
    expect(ex.extractConcept("object_definition")).toBe("SingletonObject");
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("val_definition")).toBe("Constant");
    expect(ex.extractConcept("var_definition")).toBe("Variable");
    expect(ex.extractConcept("import_declaration")).toBe("Import");
    expect(ex.extractConcept("package_clause")).toBe("Namespace");
    expect(ex.extractConcept("parameter")).toBe("Parameter");
    expect(ex.extractConcept("parameters")).toBe("Parameters");
    expect(ex.extractConcept("call_expression")).toBe("CallExpression");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("boolean_literal")).toBe("boolean_literal");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  const require = createRequire(import.meta.url);

  function parseScala(source: string): Parser.SyntaxNode {
    const mod = require("tree-sitter-scala") as Record<string, unknown>;
    const grammar = (mod.language ?? mod) as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser.parse(source).rootNode;
  }

  it("parses a class and labels it from the name field", () => {
    const source = "class Worker { def run(times: Int): Int = times }";
    const root = parseScala(source);
    const klass = root.namedChildren.find((c) => c.type === "class_definition")!;
    expect(ex.extractLabel(klass, source)).toBe("Worker");
  });

  it("parses a function and labels it from the name field", () => {
    const source = "class Worker { def run(times: Int): Int = times }";
    const root = parseScala(source);
    const fn = root.descendantsOfType("function_definition")[0]!;
    expect(ex.extractLabel(fn, source)).toBe("run");
  });

  it("labels val definitions via the pattern fallback", () => {
    const source = "class Worker { def run(times: Int): Int = { val result = times; result } }";
    const root = parseScala(source);
    const valDef = root.descendantsOfType("val_definition")[0]!;
    expect(ex.extractLabel(valDef, source)).toBe("result");
  });

  it("labels var definitions via the pattern fallback", () => {
    const source = "object O { var x = 1 }";
    const root = parseScala(source);
    const varDef = root.descendantsOfType("var_definition")[0]!;
    expect(ex.extractLabel(varDef, source)).toBe("x");
  });

  it("declares fallback types for definitions without a name field", () => {
    expect(ex.labelFallbackTypes!.has("val_definition")).toBe(true);
    expect(ex.labelFallbackTypes!.has("var_definition")).toBe(true);
  });
});
