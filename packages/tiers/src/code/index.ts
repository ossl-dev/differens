/**
 * Tier 5  --  Source code adapter.
 *
 * Uses tree-sitter to parse source code into CST nodes,
 * then applies per-language extractors to map node types
 * to canonical concepts (Function, Class, Method, etc.).
 *
 * Languages without extractors still work at L5 (generic tree-sitter
 * node types). Languages with extractors get L6 (semantic labels).
 */

import Parser from "tree-sitter";
import { createNode } from "@differens/core";
import type { Node } from "@differens/core";
import type { LanguageExtractor } from "./extractor";
import { TypeScriptExtractor } from "./typescript";
import { PythonExtractor } from "./python";
import { RustExtractor } from "./rust";
import { GoExtractor } from "./go";

// ---------- Language registry ----------

// Map file extension to tree-sitter language module
const grammarRegistry: Map<string, { grammar: Parser.Language; name: string }> = new Map();

// Map file extension to extractor (optional  --  L6)
const extractorRegistry: Map<string, LanguageExtractor> = new Map();

let initPromise: Promise<void> | null = null;

/** Initialize the language registry with available grammars */
async function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {

    // Dynamic imports to avoid requiring all grammars at bundle time
    const [jsModule, tsModule, pyModule, rsModule, goModule] = await Promise.all([
      import("tree-sitter-javascript"),
      import("tree-sitter-typescript"),
      import("tree-sitter-python"),
      import("tree-sitter-rust"),
      import("tree-sitter-go"),
    ]);

    const jsGrammar = (jsModule.default as unknown as { language: Parser.Language }).language ?? jsModule.default;
    const tsGrammar = (tsModule.default as unknown as { typescript: Parser.Language }).typescript ?? tsModule.default;
    const pyGrammar = (pyModule.default as unknown as { language: Parser.Language }).language ?? pyModule.default;
    const rsGrammar = (rsModule.default as unknown as { language: Parser.Language }).language ?? rsModule.default;
    const goGrammar = (goModule.default as unknown as { language: Parser.Language }).language ?? goModule.default;

    grammarRegistry.set("js", { grammar: jsGrammar as Parser.Language, name: "javascript" });
    grammarRegistry.set("mjs", { grammar: jsGrammar as Parser.Language, name: "javascript" });
    grammarRegistry.set("cjs", { grammar: jsGrammar as Parser.Language, name: "javascript" });
    grammarRegistry.set("jsx", { grammar: jsGrammar as Parser.Language, name: "javascript" });
    grammarRegistry.set("ts", { grammar: tsGrammar as Parser.Language, name: "typescript" });
    grammarRegistry.set("tsx", { grammar: tsGrammar as Parser.Language, name: "typescript" });
    grammarRegistry.set("py", { grammar: pyGrammar as Parser.Language, name: "python" });
    grammarRegistry.set("rs", { grammar: rsGrammar as Parser.Language, name: "rust" });
    grammarRegistry.set("go", { grammar: goGrammar as Parser.Language, name: "go" });

    // Register semantic extractors (L6)
    extractorRegistry.set("js", new TypeScriptExtractor());
    extractorRegistry.set("mjs", new TypeScriptExtractor());
    extractorRegistry.set("cjs", new TypeScriptExtractor());
    extractorRegistry.set("jsx", new TypeScriptExtractor());
    extractorRegistry.set("ts", new TypeScriptExtractor());
    extractorRegistry.set("tsx", new TypeScriptExtractor());
    extractorRegistry.set("py", new PythonExtractor());
    extractorRegistry.set("rs", new RustExtractor());
    extractorRegistry.set("go", new GoExtractor());
    } catch (err) {
      // Grammar loading failed  --  code tier won't work, but won't crash
      console.error("Failed to load tree-sitter grammars:", err);
    }
  })();

  return initPromise;
}

// ---------- CST to Node conversion ----------

/** Convert a tree-sitter CST node to our generic Node tree */
function cstToNode(
  tsNode: Parser.SyntaxNode,
  source: string,
  extractor?: LanguageExtractor,
): Node {
  const kind = extractor
    ? extractor.extractConcept(tsNode.type)
    : tsNode.type;

  const label = extractor
    ? extractor.extractLabel(tsNode, source)
    : undefined;

  const namedChildren = tsNode.namedChildren;
  const children: Node[] = [];

  for (const child of namedChildren) {
    children.push(cstToNode(child, source, extractor));
  }

  const value =
    namedChildren.length === 0
      ? source.slice(tsNode.startIndex, tsNode.endIndex)
      : undefined;

  return createNode({
    kind,
    label,
    value,
    children,
    byteRange: [tsNode.startIndex, tsNode.endIndex],
  });
}

// ---------- Public API ----------

/** Parse source code into a Node tree */
export function parseCode(source: string, extension: string): Node {
  const grammarInfo = grammarRegistry.get(extension);
  if (!grammarInfo) {
    // No grammar for this extension  --  wrap as a raw file node
    return createNode({
      kind: "file",
      label: extension,
      children: source.split("\n").map((line, i) =>
        createNode({
          kind: "line",
          label: `L${i + 1}`,
          value: line,
          byteRange: [0, line.length],
        }),
      ),
      byteRange: [0, source.length],
    });
  }

  const parser = new Parser();
  parser.setLanguage(grammarInfo.grammar);
  const tree = parser.parse(source);

  const extractor = extractorRegistry.get(extension);

  return cstToNode(tree.rootNode, source, extractor);
}

/** Await grammar loading; needed before listing extractors */
export function awaitGrammars(): Promise<void> {
  return ensureInitialized();
}

/** List all available extractors */
export function listExtractors(): { language: string; level: "L6" | "L5"; extensions: string[] }[] {
  const result: { language: string; level: "L6" | "L5"; extensions: string[] }[] = [];
  const seen = new Set<string>();

  for (const [ext, extractor] of extractorRegistry) {
    if (seen.has(extractor.language)) continue;
    seen.add(extractor.language);
    result.push({
      language: extractor.language,
      level: "L6",
      extensions: extractor.extensions,
    });
  }

  // Add L5 (generic) grammars
  for (const [ext, info] of grammarRegistry) {
    if (!extractorRegistry.has(ext)) {
      const name = info.name;
      if (!seen.has(name)) {
        seen.add(name);
        result.push({
          language: name,
          level: "L5",
          extensions: [ext],
        });
      }
    }
  }

  return result;
}

/** Trigger async initialization */
ensureInitialized().catch(() => {});
