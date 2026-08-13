import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import type { Node } from "@ossl-dev/differens-core";
import Parser from "tree-sitter";
import { GoExtractor } from "./go";
import {
  hasGrammar,
  listExtractors,
  parseCacheStats,
  parseCode,
  resetParseCacheForTest,
} from "./index";
import { PythonExtractor } from "./python";
import { RustExtractor } from "./rust";
import { TypeScriptExtractor } from "./typescript";

/** Depth-first walk collecting (kind, label) for every node. */
function walk(
  node: Node,
  out: [string, string | undefined][] = [],
): [string, string | undefined][] {
  out.push([node.kind, node.label]);
  for (const child of node.children) walk(child, out);
  return out;
}

function kinds(source: string, extension: string): [string, string | undefined][] {
  return walk(parseCode(source, extension));
}

function hasKind(source: string, extension: string, kind: string, label?: string): boolean {
  return kinds(source, extension).some(
    ([k, l]) => k === kind && (label === undefined || l === label),
  );
}

describe("TypeScriptExtractor", () => {
  const ex = new TypeScriptExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("function_declaration")).toBe("Function");
    expect(ex.extractConcept("class_declaration")).toBe("Class");
    expect(ex.extractConcept("method_definition")).toBe("Method");
    expect(ex.extractConcept("variable_declaration")).toBe("Variable");
    expect(ex.extractConcept("arrow_function")).toBe("Function");
    expect(ex.extractConcept("string")).toBe("string_literal");
    expect(ex.extractConcept("not_a_real_type")).toBe("not_a_real_type");
  });

  it("parses a function and labels it from the name field", () => {
    expect(
      hasKind(
        "export function parseConfig(raw: string) { return raw; }",
        "ts",
        "Function",
        "parseConfig",
      ),
    ).toBe(true);
  });

  it("parses classes and methods with labels", () => {
    const src = "class Worker { run(): void { this.step(); } }";
    expect(hasKind(src, "ts", "Class", "Worker")).toBe(true);
    expect(hasKind(src, "ts", "Method", "run")).toBe(true);
  });

  it("labels variable declarations via the declarator fallback", () => {
    expect(hasKind("const timeout = 5;", "ts", "Variable", "timeout")).toBe(true);
    expect(hasKind("let count = 0;", "ts", "Variable", "count")).toBe(true);
  });

  it("parses JSX through the same extractor", () => {
    expect(hasKind('export const App = () => <div id="x">hi</div>;', "tsx", "JSXElement")).toBe(
      true,
    );
  });
});

describe("PythonExtractor", () => {
  const ex = new PythonExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("function_definition")).toBe("Function");
    expect(ex.extractConcept("class_definition")).toBe("Class");
    expect(ex.extractConcept("decorated_definition")).toBe("DecoratedDef");
    expect(ex.extractConcept("list_comprehension")).toBe("ListComp");
    expect(ex.extractConcept("none")).toBe("null_literal");
    expect(ex.extractConcept("unknown_type")).toBe("unknown_type");
  });

  it("parses a function and labels it", () => {
    expect(
      hasKind("def parse_config(raw):\n    return raw\n", "py", "Function", "parse_config"),
    ).toBe(true);
  });

  it("parses classes and methods", () => {
    const src = "class Worker:\n    def run(self):\n        return 1\n";
    expect(hasKind(src, "py", "Class", "Worker")).toBe(true);
    expect(hasKind(src, "py", "Function", "run")).toBe(true);
  });
});

describe("RustExtractor", () => {
  const ex = new RustExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("function_item")).toBe("Function");
    expect(ex.extractConcept("struct_item")).toBe("Struct");
    expect(ex.extractConcept("impl_item")).toBe("Impl");
    expect(ex.extractConcept("use_declaration")).toBe("Import");
    expect(ex.extractConcept("string_literal")).toBe("string_literal");
    expect(ex.extractConcept("unknown_type")).toBe("unknown_type");
  });

  it("parses a function and labels it", () => {
    expect(
      hasKind("fn parse_config(raw: &str) -> bool { true }", "rs", "Function", "parse_config"),
    ).toBe(true);
  });

  it("labels type definitions via the type-field fallback", () => {
    expect(hasKind("type UserId = u64;", "rs", "TypeDef", "UserId")).toBe(true);
  });
});

describe("GoExtractor", () => {
  const ex = new GoExtractor();

  it("maps node types to canonical concepts", () => {
    expect(ex.extractConcept("function_declaration")).toBe("Function");
    expect(ex.extractConcept("method_declaration")).toBe("Method");
    expect(ex.extractConcept("struct_type")).toBe("Struct");
    expect(ex.extractConcept("go_statement")).toBe("Goroutine");
    expect(ex.extractConcept("int_literal")).toBe("integer_literal");
    expect(ex.extractConcept("unknown_type")).toBe("unknown_type");
  });

  it("parses a function and labels it", () => {
    expect(
      hasKind(
        "package main\nfunc parseConfig(raw string) string { return raw }\n",
        "go",
        "Function",
        "parseConfig",
      ),
    ).toBe(true);
  });

  it("parses methods on structs", () => {
    const src = "package main\ntype W struct{}\nfunc (w W) run() {}\n";
    expect(hasKind(src, "go", "Method", "run")).toBe(true);
  });
});

describe("grammar registry", () => {
  it("reports working grammars", () => {
    for (const ext of ["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "go"]) {
      expect(hasGrammar(ext)).toBe(true);
    }
  });

  it("reports working grammars for every registered language", () => {
    const exts = ["c", "cpp", "java", "rb", "php", "swift", "kt", "cs", "scala", "lua", "sh"];
    for (const ext of exts) expect(hasGrammar(ext)).toBe(true);
  });

  it("reports no grammar for unregistered extensions", () => {
    expect(hasGrammar("css")).toBe(false);
    expect(hasGrammar("unknown")).toBe(false);
  });

  it("lists one entry per language at L6 with its extensions", () => {
    const extractors = listExtractors();
    expect(extractors.length).toBe(16);
    const byLang = new Map(extractors.map((e) => [e.language, e]));
    expect(byLang.get("javascript")!.extensions).toEqual(["js", "mjs", "cjs", "jsx"]);
    expect(byLang.get("typescript")!.extensions).toEqual(["ts", "tsx"]);
    expect(byLang.get("python")!.extensions).toEqual(["py"]);
    expect(byLang.get("go")!.extensions).toEqual(["go"]);
    expect(byLang.get("rust")!.extensions).toEqual(["rs"]);
    expect(byLang.get("bash")!.extensions).toEqual(["sh", "bash", "zsh"]);
    expect(byLang.get("csharp")!.extensions).toEqual(["cs"]);
    for (const e of extractors) expect(e.level).toBe("L6");
  });
});

describe("extractor-backed languages end to end", () => {
  it("maps java to canonical concepts with labels", () => {
    const src = "class Foo { void bar() {} }";
    expect(hasKind(src, "java", "file")).toBe(true);
    expect(hasKind(src, "java", "Class", "Foo")).toBe(true);
    expect(hasKind(src, "java", "Method", "bar")).toBe(true);
  });

  it("maps C and C++ constructs", () => {
    expect(hasKind("int main() { return 0; }", "c", "Function", "main")).toBe(true);
    expect(hasKind("class Foo { public: int bar(); };", "cpp", "Class", "Foo")).toBe(true);
  });

  it("maps ruby, php, swift, scala, bash, and lua constructs", () => {
    expect(hasKind("class Foo\n  def bar\n  end\nend", "rb", "Class", "Foo")).toBe(true);
    expect(hasKind("class Foo\n  def bar\n  end\nend", "rb", "Method", "bar")).toBe(true);
    expect(hasKind("<?php class Foo { function bar() {} }", "php", "Class", "Foo")).toBe(true);
    expect(hasKind("<?php class Foo { function bar() {} }", "php", "Method", "bar")).toBe(true);
    expect(hasKind("class Foo { func bar() {} }", "swift", "Class", "Foo")).toBe(true);
    expect(hasKind("class Foo { func bar() {} }", "swift", "Function", "bar")).toBe(true);
    expect(hasKind("class Foo { def bar() = 1 }", "scala", "Class", "Foo")).toBe(true);
    expect(hasKind("class Foo { def bar() = 1 }", "scala", "Function", "bar")).toBe(true);
    expect(hasKind("foo() { echo hi; }", "sh", "Function", "foo")).toBe(true);
    expect(hasKind("function foo() return 1 end", "lua", "Function", "foo")).toBe(true);
  });

  it("maps C# and Kotlin through their dlopen-loaded bindings", () => {
    expect(hasKind("class Foo { void Bar() {} }", "cs", "Class", "Foo")).toBe(true);
    expect(hasKind("class Foo { void Bar() {} }", "cs", "Method", "Bar")).toBe(true);
    expect(hasKind("class Foo { fun bar() {} }", "kt", "Class", "Foo")).toBe(true);
    expect(hasKind("class Foo { fun bar() {} }", "kt", "Function", "bar")).toBe(true);
  });

  it("recovers from garbage input in a grammar-less fallback extension", () => {
    const tree = parseCode("p { color: red }", "css");
    expect(tree.kind).toBe("file");
    expect(tree.label).toBe("css");
    expect(tree.children[0]!.kind).toBe("line");
    expect(tree.children[0]!.value).toBe("p { color: red }");
  });
});

describe("parseCode fallbacks", () => {
  it("recovers from garbage input with error nodes", () => {
    const tree = parseCode("\u0000\u0001 not code at all", "ts");
    // The root survives as a file node and the unparseable bytes surface as
    // tree-sitter ERROR nodes instead of crashing.
    expect(tree.kind).toBe("file");
    expect(walk(tree).some(([k]) => k === "ERROR")).toBe(true);
  });

  it("attaches 1-based source lines to named nodes", () => {
    const tree = parseCode("const a = 1;\n\nexport function go(): void {}\n", "ts");
    const out: Node[] = [];
    const collect = (n: Node): void => {
      out.push(n);
      for (const c of n.children) collect(c);
    };
    collect(tree);
    const fn = out.find((n) => n.kind === "Function");
    expect(fn).toBeDefined();
    expect(fn!.line).toBe(3);
  });
});

describe("extractor label rules", () => {
  const require = createRequire(import.meta.url);

  function parseWith(module: string, pick: string | undefined, source: string): Parser.SyntaxNode {
    const mod = require(module) as Record<string, unknown>;
    const grammar = (pick ? mod[pick] : (mod.language ?? mod)) as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser.parse(source).rootNode;
  }

  it("go: labels functions from the name field", () => {
    const source = "package main\nfunc run() {}\n";
    const root = parseWith("tree-sitter-go", undefined, source);
    const fn = root.namedChildren.find((c) => c.type === "function_declaration")!;
    expect(new GoExtractor().extractLabel(fn, source)).toBe("run");
  });

  it("python: labels functions from the name field", () => {
    const root = parseWith("tree-sitter-python", undefined, "def parse(x):\n    return x\n");
    const fn = root.namedChildren.find((c) => c.type === "function_definition")!;
    expect(new PythonExtractor().extractLabel(fn, "def parse(x):")).toBe("parse");
  });

  it("rust: labels type definitions from the type field", () => {
    const root = parseWith("tree-sitter-rust", undefined, "type UserId = u64;");
    const item = root.namedChildren.find((c) => c.type === "type_item")!;
    expect(new RustExtractor().extractLabel(item, "type UserId = u64;")).toBe("UserId");
  });

  it("typescript: labels variable declarators via the fallback", () => {
    const root = parseWith("tree-sitter-typescript", "typescript", "const timeout = 5;");
    const decl = root.namedChildren.find((c) => c.type === "lexical_declaration")!;
    expect(new TypeScriptExtractor().extractLabel(decl, "const timeout = 5;")).toBe("timeout");
  });
});

describe("parse cache", () => {
  it("reuses the tree for identical content and extension", () => {
    resetParseCacheForTest();
    const a = parseCode("class A { void m() {} }", "java");
    const b = parseCode("class A { void m() {} }", "java");
    expect(b).toBe(a);
    expect(parseCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("keeps entries separate per extension", () => {
    resetParseCacheForTest();
    const a = parseCode("class A {}", "java");
    const b = parseCode("class A {}", "cs");
    expect(b).not.toBe(a);
    expect(parseCacheStats().size).toBe(2);
  });

  it("evicts the oldest entry past the cap", () => {
    resetParseCacheForTest();
    for (let i = 0; i < 70; i++) parseCode(`class A${i} {}`, "java");
    expect(parseCacheStats().size).toBeLessThanOrEqual(64);
  });
});
