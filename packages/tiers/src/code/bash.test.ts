import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { BashExtractor } from "./bash";

describe("BashExtractor", () => {
  const ex = new BashExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("program")).toBe("file");
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("command")).toBe("CallExpression");
    expect(ex.extractConcept("variable_assignment")).toBe("Variable");
    expect(ex.extractConcept("simple_expansion")).toBe("Variable");
    expect(ex.extractConcept("if_statement")).toBe("IfBlock");
    expect(ex.extractConcept("for_statement")).toBe("ForLoop");
    expect(ex.extractConcept("while_statement")).toBe("WhileLoop");
    expect(ex.extractConcept("case_statement")).toBe("SwitchBlock");
    expect(ex.extractConcept("compound_statement")).toBe("Block");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("number")).toBe("number_literal");
    expect(ex.extractConcept("comment")).toBe("Comment");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  const require = createRequire(import.meta.url);

  function parseBash(source: string): Parser.SyntaxNode {
    const mod = require("tree-sitter-bash") as Record<string, unknown>;
    const grammar = (mod.language ?? mod) as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser.parse(source).rootNode;
  }

  it("parses a function and labels it from the name field", () => {
    const source = "increment() { echo hi; }";
    const root = parseBash(source);
    const fn = root.namedChildren.find((c) => c.type === "function_definition")!;
    expect(ex.extractLabel(fn, source)).toBe("increment");
  });

  it("labels variable assignments from the name field", () => {
    const source = "x=5";
    const root = parseBash(source);
    const assignment = root.namedChildren.find((c) => c.type === "variable_assignment")!;
    expect(ex.extractLabel(assignment, source)).toBe("x");
  });

  it("labels commands from the name field", () => {
    const source = "increment() { echo hi; }";
    const root = parseBash(source);
    const command = root.descendantsOfType("command")[0]!;
    expect(ex.extractLabel(command, source)).toBe("echo");
  });
});
