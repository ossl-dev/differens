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

import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { createNode } from "@differens/core";
import type { Node } from "@differens/core";
import type { LanguageExtractor } from "./extractor";
import { TypeScriptExtractor } from "./typescript";
import { PythonExtractor } from "./python";
import { RustExtractor } from "./rust";
import { GoExtractor } from "./go";

// ---------- Language registry ----------

/**
 * Grammars load synchronously and on demand.
 *
 * They used to load via `await import()` kicked off at module load, which
 * raced diffWithTier: that function is synchronous, so any file diffed before
 * the imports settled found an empty registry and silently fell back to a line
 * diff while still reporting the code tier. Loading a grammar the first time
 * its extension is seen also means diffing a Python changeset never pays for
 * the Rust and Go grammars.
 */
const require = createRequire(import.meta.url);

interface LanguageSpec {
  name: string;
  module: string;
  /** Grammar modules export either `.language`, a named dialect, or the grammar itself */
  pick?: string;
  extractor?: () => LanguageExtractor;
}

const LANGUAGES: Record<string, LanguageSpec> = {
  js: { name: "javascript", module: "tree-sitter-javascript", extractor: () => new TypeScriptExtractor() },
  mjs: { name: "javascript", module: "tree-sitter-javascript", extractor: () => new TypeScriptExtractor() },
  cjs: { name: "javascript", module: "tree-sitter-javascript", extractor: () => new TypeScriptExtractor() },
  jsx: { name: "javascript", module: "tree-sitter-javascript", extractor: () => new TypeScriptExtractor() },
  ts: { name: "typescript", module: "tree-sitter-typescript", pick: "typescript", extractor: () => new TypeScriptExtractor() },
  tsx: { name: "typescript", module: "tree-sitter-typescript", pick: "tsx", extractor: () => new TypeScriptExtractor() },
  py: { name: "python", module: "tree-sitter-python", extractor: () => new PythonExtractor() },
  rs: { name: "rust", module: "tree-sitter-rust", extractor: () => new RustExtractor() },
  go: { name: "go", module: "tree-sitter-go", extractor: () => new GoExtractor() },
};

interface LoadedLanguage {
  grammar: Parser.Language;
  name: string;
  extractor?: LanguageExtractor;
  /** Parsers are reusable and not cheap to build; keep one per grammar. */
  parser: Parser;
}

const loaded = new Map<string, LoadedLanguage | null>();

function loadLanguage(extension: string): LoadedLanguage | null {
  const cached = loaded.get(extension);
  if (cached !== undefined) return cached;

  const spec = LANGUAGES[extension];
  if (!spec) {
    loaded.set(extension, null);
    return null;
  }

  let entry: LoadedLanguage | null = null;
  try {
    const mod = requireGrammar(spec.module);
    const root = (mod?.default ?? mod) as Record<string, unknown>;
    const grammar = (spec.pick ? root[spec.pick] : root.language ?? root) as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(grammar);
    entry = { grammar, name: spec.name, extractor: spec.extractor?.(), parser };
  } catch (err) {
    // Missing or unbuildable native grammar: the caller falls back to a line
    // diff, which is the whole point of the tier ladder.
    warnOnce(`differens: ${spec.name} falls back to a line diff (${err instanceof Error ? err.message : err})`);
    entry = null;
  }

  loaded.set(extension, entry);
  return entry;
}

/**
 * Grammars are native addons, so a `--compile`d executable cannot embed them:
 * its own module root is the virtual /$bunfs/ tree with no node_modules. Try
 * the working directory as well, which recovers semantic diffs whenever the
 * binary is run inside a project that has the grammars installed.
 */
function requireGrammar(module: string): Record<string, unknown> {
  try {
    return require(module) as Record<string, unknown>;
  } catch (err) {
    const local = createRequire(`${process.cwd()}/package.json`);
    try {
      return local(module) as Record<string, unknown>;
    } catch {
      throw err;
    }
  }
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  // Worker children inherit stderr; without this the same notice prints once
  // per process in the pool.
  if (process.env.DIFFERENS_QUIET === "1" || warned.has(message)) return;
  warned.add(message);
  console.error(message);
}

// ---------- CST to Node conversion ----------

/**
 * Convert a tree-sitter CST into our generic Node tree.
 *
 * Driven by a TreeCursor rather than by `node.namedChildren`. The binding
 * materialises a fresh JS wrapper object for every node that array touches,
 * which measured 3.3x slower than the cursor on a 174k-node file and made
 * traversal, not parsing, the dominant cost of a large diff. The cursor
 * exposes type/extent/field name as primitives and allocates nothing.
 *
 * It is also iterative, so deeply nested real files (long method chains, big
 * nested literals) cannot overflow the stack mid-parse.
 */
function cstToNode(
  tree: Parser.Tree,
  source: string,
  extractor?: LanguageExtractor,
): Node {
  interface Frame {
    type: string;
    start: number;
    end: number;
    line: number;
    depth: number;
    label?: string;
    kids: Node[];
    /** Set when the node type needs the extractor's non-generic label rule */
    needsFallback: boolean;
  }

  const cursor = tree.walk();
  const stack: Frame[] = [];
  let result: Node | undefined;

  const enter = (): void => {
    // Every extractor's primary label rule is "the child in the name field",
    // so read it off the cursor instead of re-querying it per node.
    if (cursor.currentFieldName === "name" && stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      if (parent.label === undefined) {
        parent.label = source.slice(cursor.startIndex, cursor.endIndex);
      }
    }
    if (!cursor.nodeIsNamed) return;
    const type = cursor.nodeType;
    stack.push({
      type,
      start: cursor.startIndex,
      end: cursor.endIndex,
      line: cursor.startPosition.row + 1,
      depth: cursor.currentDepth,
      kids: [],
      needsFallback: extractor?.labelFallbackTypes?.has(type) ?? false,
    });
  };

  const leave = (): void => {
    const frame = stack[stack.length - 1];
    if (!frame || frame.depth !== cursor.currentDepth) return;
    stack.pop();
    let label = frame.label;
    if (label === undefined && frame.needsFallback && extractor) {
      label = extractor.extractLabel(cursor.currentNode, source);
    }
    const node = createNode({
      kind: extractor ? extractor.extractConcept(frame.type) : frame.type,
      label,
      value: frame.kids.length === 0 ? source.slice(frame.start, frame.end) : undefined,
      children: frame.kids,
      byteRange: [frame.start, frame.end],
      line: frame.line,
    });
    if (stack.length > 0) stack[stack.length - 1]!.kids.push(node);
    else result = node;
  };

  enter();
  for (;;) {
    if (cursor.gotoFirstChild()) {
      enter();
      continue;
    }
    let finished = false;
    for (;;) {
      leave();
      if (cursor.gotoNextSibling()) {
        enter();
        break;
      }
      if (!cursor.gotoParent()) {
        finished = true;
        break;
      }
    }
    if (finished) break;
  }

  return result!;
}

// ---------- Public API ----------

/** Does this extension have a working tree-sitter grammar? */
export function hasGrammar(extension: string): boolean {
  return loadLanguage(extension) !== null;
}

/** Parse source code into a Node tree */
export function parseCode(source: string, extension: string): Node {
  const lang = loadLanguage(extension);
  if (!lang) {
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

  return cstToNode(lang.parser.parse(source), source, lang.extractor);
}

/**
 * Kept for API compatibility: grammars are loaded synchronously now, so
 * there is nothing left to await beyond forcing them all in for `languages`.
 */
export function awaitGrammars(): Promise<void> {
  for (const ext of Object.keys(LANGUAGES)) loadLanguage(ext);
  return Promise.resolve();
}

/** List all available extractors */
export function listExtractors(): { language: string; level: "L6" | "L5"; extensions: string[] }[] {
  const result: { language: string; level: "L6" | "L5"; extensions: string[] }[] = [];
  const seen = new Set<string>();

  for (const ext of Object.keys(LANGUAGES)) {
    const lang = loadLanguage(ext);
    if (!lang || seen.has(lang.name)) continue;
    seen.add(lang.name);
    result.push({
      language: lang.name,
      level: lang.extractor ? "L6" : "L5",
      // Derived from the registry, not from the extractor: one extractor can
      // back several languages and would over-report its extensions.
      extensions: Object.keys(LANGUAGES).filter((e) => LANGUAGES[e]!.name === lang.name),
    });
  }

  return result;
}
