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

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createNode, hashText } from "@ossl-dev/differens-core";
import type { Node } from "@ossl-dev/differens-core";
import Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";
import { GoExtractor } from "./go";
import { PythonExtractor } from "./python";
import { RustExtractor } from "./rust";
import { TypeScriptExtractor } from "./typescript";

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
interface LanguageSpec {
  name: string;
  module: string;
  /** Grammar modules export either `.language`, a named dialect, or the grammar itself */
  pick?: string;
  /**
   * ESM-only wrappers (top-level await) cannot be require()d; attempting to
   * runs them far enough to print their own failure noise. Load the raw
   * binding instead. See requireBinding.
   */
  esm?: boolean;
  extractor?: () => LanguageExtractor;
}

const LANGUAGES: Record<string, LanguageSpec> = {
  js: {
    name: "javascript",
    module: "tree-sitter-javascript",
    extractor: () => new TypeScriptExtractor(),
  },
  mjs: {
    name: "javascript",
    module: "tree-sitter-javascript",
    extractor: () => new TypeScriptExtractor(),
  },
  cjs: {
    name: "javascript",
    module: "tree-sitter-javascript",
    extractor: () => new TypeScriptExtractor(),
  },
  jsx: {
    name: "javascript",
    module: "tree-sitter-javascript",
    extractor: () => new TypeScriptExtractor(),
  },
  ts: {
    name: "typescript",
    module: "tree-sitter-typescript",
    pick: "typescript",
    extractor: () => new TypeScriptExtractor(),
  },
  tsx: {
    name: "typescript",
    module: "tree-sitter-typescript",
    pick: "tsx",
    extractor: () => new TypeScriptExtractor(),
  },
  py: { name: "python", module: "tree-sitter-python", extractor: () => new PythonExtractor() },
  rs: { name: "rust", module: "tree-sitter-rust", extractor: () => new RustExtractor() },
  go: { name: "go", module: "tree-sitter-go", extractor: () => new GoExtractor() },
  // L5 generic fallback: grammars without extractors diff as raw tree-sitter
  // CSTs. Node types and standard field names carry the semantics.
  c: { name: "c", module: "tree-sitter-c" },
  cpp: { name: "cpp", module: "tree-sitter-cpp" },
  java: { name: "java", module: "tree-sitter-java" },
  rb: { name: "ruby", module: "tree-sitter-ruby" },
  php: { name: "php", module: "tree-sitter-php", pick: "php" },
  swift: { name: "swift", module: "tree-sitter-swift" },
  kt: { name: "kotlin", module: "tree-sitter-kotlin" },
  cs: { name: "csharp", module: "tree-sitter-c-sharp", esm: true },
  scala: { name: "scala", module: "tree-sitter-scala" },
  lua: { name: "lua", module: "@tree-sitter-grammars/tree-sitter-lua", esm: true },
  sh: { name: "bash", module: "tree-sitter-bash" },
  bash: { name: "bash", module: "tree-sitter-bash" },
  zsh: { name: "bash", module: "tree-sitter-bash" },
};

interface LoadedLanguage {
  grammar: Parser.Language;
  name: string;
  extractor?: LanguageExtractor;
  /** Parsers are reusable and not cheap to build; keep one per grammar. */
  parser: Parser;
}

const loaded = new Map<string, LoadedLanguage | null>();

/** Test hook: forget every loaded grammar so failure paths can be exercised. */
export function resetLanguagesForTest(): void {
  loaded.clear();
}

type GrammarLoader = (module: string) => Record<string, unknown>;

/**
 * Load and cache a grammar. The loader is a parameter so the failure paths
 * (missing or unbuildable native grammar) are testable without uninstalling
 * the real grammars.
 */
export function loadLanguage(extension: string, loader?: GrammarLoader): LoadedLanguage | null {
  const cached = loaded.get(extension);
  if (cached !== undefined) return cached;

  const spec = LANGUAGES[extension];
  if (!spec) {
    loaded.set(extension, null);
    return null;
  }

  let entry: LoadedLanguage | null = null;
  try {
    const mod = (loader ?? (spec.esm ? requireBinding : requireGrammar))(spec.module);
    const root = (mod?.default ?? mod) as Record<string, unknown>;
    const grammar = (spec.pick ? root[spec.pick] : (root.language ?? root)) as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(grammar);
    entry = { grammar, name: spec.name, extractor: spec.extractor?.(), parser };
  } catch (err) {
    // Missing or unbuildable native grammar: the caller falls back to a line
    // diff, which is the whole point of the tier ladder.
    warnOnce(
      `differens: ${spec.name} falls back to a line diff (${err instanceof Error ? err.message : err})`,
    );
    entry = null;
  }

  loaded.set(extension, entry);
  return entry;
}

/** Resolve a module from a base URL, or report the error. */
function tryRequire(
  module: string,
  from: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: createRequire(from)(module) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Grammars are native addons, so a `--compile`d executable cannot embed them:
 * its own module root is the virtual /$bunfs/ tree with no node_modules. Try
 * the working directory as well, which recovers semantic diffs whenever the
 * binary is run inside a project that has the grammars installed.
 */
export function requireGrammar(
  module: string,
  from: string = import.meta.url,
): Record<string, unknown> {
  const first = tryRequire(module, from);
  if (first.ok) return first.value;
  const second = tryRequire(module, `${process.cwd()}/package.json`);
  if (second.ok) return second.value;
  const binding =
    tryLoadBinding(module, from) ?? tryLoadBinding(module, `${process.cwd()}/package.json`);
  if (binding.ok) return binding.value;
  throw first.error;
}

/**
 * Load a grammar that ships only as an ESM wrapper, skipping require entirely.
 *
 * require() of a module with top-level await throws after running the wrapper
 * far enough to print its own nested import failure, which is noise on stderr
 * for a load we recover from. The binding is a plain .node file: load it
 * directly. See tryLoadBinding for how the file is found.
 */
export function requireBinding(
  module: string,
  from: string = import.meta.url,
): Record<string, unknown> {
  const first = tryLoadBinding(module, from);
  if (first.ok) return first.value;
  const second = tryLoadBinding(module, `${process.cwd()}/package.json`);
  if (second.ok) return second.value;
  throw new Error(`cannot load native binding for ${module}`);
}

/**
 * Load a grammar binding that only ships as an ESM wrapper.
 *
 * A few grammar packages wrap their native binding in a module with top-level
 * await, which `require` cannot load. The binding itself is a plain .node file
 * next to that wrapper, so load it directly with dlopen. tree-sitter must be
 * imported before the binding loads; it is, at the top of this module.
 *
 * Bun renames .node files inside its module store, so the directory is scanned
 * rather than the filename guessed. The build/Release path covers grammars
 * that ship source-only and compile on install.
 */
function tryLoadBinding(
  module: string,
  from: string,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const pkg = createRequire(from).resolve(`${module}/package.json`);
    const root = pkg.slice(0, -"package.json".length);
    const dirs = [`${root}prebuilds/${process.platform}-${process.arch}/`, `${root}build/Release/`];
    for (const dir of dirs) {
      try {
        const file = readdirSync(dir).find((f) => f.endsWith(".node"));
        if (!file) continue;
        const mod = { exports: {} as Record<string, unknown> };
        process.dlopen(mod, dir + file);
        return { ok: true, value: mod.exports };
      } catch {
        // Try the next candidate directory.
      }
    }
  } catch {
    // Package not resolvable from here; the caller tries the cwd next.
  }
  return { ok: false };
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  // Worker children inherit stderr; without this the same notice prints once
  // per process in the pool.
  if (process.env.DIFFERENS_QUIET === "1" || warned.has(message)) return;
  warned.add(message);
  console.error(message);
}

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
function cstToNode(tree: Parser.Tree, source: string, extractor?: LanguageExtractor): Node {
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

/** Does this extension have a working tree-sitter grammar? */
export function hasGrammar(extension: string): boolean {
  return loadLanguage(extension) !== null;
}

/**
 * Content-addressed parse cache: parsing dominates the cost of a diff, and
 * the same file content reappears constantly across a changeset (a file in
 * two commits, duplicated vendored sources, the two sides of a cross-file
 * move). Keyed by a hash of the content plus the extension -- the same bytes
 * are a different tree in a different language. The cap keeps a long-running
 * process from pinning one tree per file it has ever seen.
 */
const PARSE_CACHE_CAP = 64;
const parseCache = new Map<string, Node>();
let cacheHits = 0;
let cacheMisses = 0;

/** Test hook: empty the parse cache and reset the counters. */
export function resetParseCacheForTest(): void {
  parseCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/** Test hook: parse-cache counters. */
export function parseCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: cacheHits, misses: cacheMisses, size: parseCache.size };
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

  const key = `${hashText(source)}:${extension}`;
  const cached = parseCache.get(key);
  if (cached !== undefined) {
    cacheHits++;
    parseCache.delete(key); // refresh LRU position
    parseCache.set(key, cached);
    return cached;
  }
  cacheMisses++;

  const tree = cstToNode(lang.parser.parse(source), source, lang.extractor);
  parseCache.set(key, tree);
  if (parseCache.size > PARSE_CACHE_CAP) {
    parseCache.delete(parseCache.keys().next().value!);
  }
  return tree;
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
