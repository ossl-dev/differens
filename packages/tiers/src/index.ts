/**
 * Tier Adapters  --  parse files into Node trees for the diff core.
 *
 * The content router picks a tier based on file extension and magic bytes,
 * then delegates to the appropriate adapter. Each adapter produces a Node
 * tree that feeds into @ossl-dev/differens-core's matching algorithm.
 *
 * @packageDocumentation
 */

import type { Node } from "@ossl-dev/differens-core";
import { createNode, diffTrees } from "@ossl-dev/differens-core";
import { isBinaryExtension } from "./binary";
import { awaitGrammars, hasGrammar, listExtractors, parseCode } from "./code/index";
import { parseData } from "./data";
import { type MarkupNode, parseMarkup } from "./markup";
import { diffWords } from "./prose";
import { diffLines } from "./raw";

export enum Tier {
  Binary = 0,
  Raw = 1,
  Prose = 2,
  Markup = 3,
  Data = 4,
  Code = 5,
}

export interface FileInfo {
  path: string;
  extension: string;
  tier: Tier;
}

/** Map file extension to tier */
export function classifyFile(filePath: string): FileInfo {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const path = filePath.toLowerCase();

  // Binary
  if (isBinaryExtension(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Binary };
  }

  // Config / structured data
  if (["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg"].includes(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Data };
  }

  // Markup
  if (["html", "htm", "xml", "svg", "xaml", "plist"].includes(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Markup };
  }

  // Markdown and doc formats: line diff, not word diff.
  // Lines are structure in these files; word-level churn floods the output.
  if (["md", "mdx", "rst", "adoc", "org"].includes(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Raw };
  }

  // Free prose: word diff
  if (
    ["txt", "log"].includes(ext) ||
    path.endsWith("license") ||
    path.endsWith("readme") ||
    path.endsWith("changelog") ||
    path.endsWith("authors")
  ) {
    return { path: filePath, extension: ext, tier: Tier.Prose };
  }

  // Code (tree-sitter backed)
  const codeExts = [
    "rs",
    "c",
    "cpp",
    "h",
    "hpp",
    "go",
    "java",
    "kt",
    "py",
    "rb",
    "php",
    "swift",
    "cs",
    "js",
    "mjs",
    "cjs",
    "ts",
    "jsx",
    "tsx",
    "scala",
    "lua",
    "sh",
    "sql",
    "bash",
    "zsh",
    "fish",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "astro",
  ];
  if (codeExts.includes(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Code };
  }

  // Default: raw diff
  return { path: filePath, extension: ext, tier: Tier.Raw };
}

export interface TierDiffResult {
  changes: import("@ossl-dev/differens-core").EditAction[];
  fallback?: string;
  nodeCount: number;
  tier: Tier;
}

/**
 * Diff two files through the appropriate tier adapter.
 * If a tier fails, falls back to the next lower tier.
 */
export function diffWithTier(
  oldSource: string,
  newSource: string,
  oldPath: string,
  newPath: string,
): TierDiffResult {
  const info = classifyFile(oldPath);

  // A file that is entirely new or entirely gone is one fact, not a tree
  // diff. Parsing it produces an Insert per top-level construct, which buries
  // the only thing the reader needs to know.
  if (oldSource === "" && newSource !== "") return wholeFile("Insert", newPath, newSource);
  if (newSource === "" && oldSource !== "") return wholeFile("Delete", oldPath, oldSource);

  // Short-circuit on identical sources. String comparison, not a UTF-8
  // encode of both sides: encoding allocated two full copies of every file
  // just to answer a question the strings already answer.
  if (oldSource === newSource) {
    return { changes: [], nodeCount: 0, tier: info.tier };
  }

  // Binary sniff: NUL bytes or failed UTF-8 decode (replacement chars).
  // Handles .dat, .bin without extension lists, git blobs, etc.
  if (
    info.tier === Tier.Raw &&
    (hasNullByte(oldSource) ||
      hasNullByte(newSource) ||
      oldSource.includes("�") ||
      newSource.includes("�"))
  ) {
    return diffBinary(oldSource, newSource);
  }

  // A tier is used only if it both parses AND produces a usable tree diff.
  // The core bails out to a line diff on oversized trees, and that verdict
  // has to propagate: reporting the core's empty change list as the code
  // tier's answer would claim a 200k-node file had no changes at all.
  const attempt = (fn: () => TierDiffResult): TierDiffResult | undefined => {
    try {
      const result = fn();
      return result.fallback ? undefined : result;
    } catch {
      return undefined;
    }
  };

  let result: TierDiffResult | undefined;
  switch (info.tier) {
    case Tier.Binary:
      return diffBinary(oldSource, newSource);
    case Tier.Data:
      result = attempt(() => diffData(oldSource, newSource));
      break;
    case Tier.Markup:
      result = attempt(() => diffMarkup(oldSource, newSource));
      break;
    case Tier.Prose:
      result = attempt(() => diffProse(oldSource, newSource));
      break;
    case Tier.Code:
      result = attempt(() => diffCode(oldSource, newSource, info.extension));
      break;
  }
  if (result) return result;

  // Raw fallback
  const raw = diffRaw(oldSource, newSource);
  return info.tier === Tier.Raw ? raw : { ...raw, fallback: "lines" };
}

/** One action standing for a whole added or removed file. */
function wholeFile(type: "Insert" | "Delete", path: string, source: string): TierDiffResult {
  const info = classifyFile(path);
  // The source goes in `value` so the node's contentHash covers it. The
  // cross-file correlator compares these nodes to spot a file that was moved
  // or renamed; keyed on anything shorter (a path, a line count) it matched
  // unrelated files whose paths merely shared directory names.
  // Narration shows the label, so the body never reaches the output.
  const node = createNode({
    kind: "file",
    label: path,
    value: source,
    byteRange: [0, source.length],
  });
  return {
    changes: [
      type === "Delete"
        ? { type: "Delete", node, context: [] }
        : {
            type: "Insert",
            node,
            parent: createNode({ kind: "tree", byteRange: [0, 0] }),
            position: 0,
            context: [],
          },
    ],
    nodeCount: 1,
    tier: info.tier,
  };
}

function hasNullByte(source: string): boolean {
  // First 8k chars is plenty for a sniff
  const limit = Math.min(source.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 0) return true;
  }
  return false;
}

function diffBinary(oldSource: string, newSource: string): TierDiffResult {
  return {
    changes: [
      {
        type: "Update" as const,
        context: [],
        node: createNode({ kind: "binary_file", byteRange: [0, oldSource.length] }),
        detail: {
          kind: "ValueChanged" as const,
          from: `${oldSource.length} bytes`,
          to: `${newSource.length} bytes`,
        },
      },
    ],
    nodeCount: 0,
    tier: Tier.Binary,
  };
}

function diffRaw(oldSource: string, newSource: string): TierDiffResult {
  const diffs = diffLines(oldSource, newSource);
  return {
    changes: diffs.map((d, i) => {
      const node = createNode({
        kind: "line",
        value: d.text,
        byteRange: [0, d.text.length],
      });
      if (d.type === "Insert") {
        return {
          type: "Insert" as const,
          context: [],
          node,
          parent: createNode({ kind: "file", byteRange: [0, 0] }),
          position: i,
        };
      }
      if (d.type === "Update") {
        return {
          type: "Update" as const,
          context: [],
          node,
          detail: {
            kind: "ValueChanged" as const,
            from: d.oldText,
            to: d.newText,
          },
        };
      }
      return { type: "Delete" as const, context: [], node };
    }),
    nodeCount: diffs.length,
    tier: Tier.Raw,
  };
}

function diffProse(oldSource: string, newSource: string): TierDiffResult {
  const wordDiffs = diffWords(oldSource, newSource);
  return {
    changes: wordDiffs.map((d, i) => {
      const node = createNode({
        kind: "word",
        value: d.text,
        byteRange: [0, d.text.length],
      });
      if (d.type === "Insert") {
        return {
          type: "Insert" as const,
          context: [],
          node,
          parent: createNode({ kind: "paragraph", byteRange: [0, 0] }),
          position: i,
        };
      }
      if (d.type === "Update") {
        return {
          type: "Update" as const,
          context: [],
          node,
          detail: {
            kind: "ValueChanged" as const,
            from: d.oldText,
            to: d.newText,
          },
        };
      }
      return { type: "Delete" as const, context: [], node };
    }),
    nodeCount: wordDiffs.length,
    tier: Tier.Prose,
  };
}

function diffMarkup(oldSource: string, newSource: string): TierDiffResult {
  const oldTree = markupToNodeTree(parseMarkup(oldSource));
  const newTree = markupToNodeTree(parseMarkup(newSource));
  const result = diffTrees(oldTree, newTree);
  return {
    changes: result.changes,
    nodeCount: result.nodeCount,
    tier: Tier.Markup,
    fallback: result.fallback,
  };
}

function diffData(oldSource: string, newSource: string): TierDiffResult {
  const oldTree = parseData(oldSource);
  const newTree = parseData(newSource);
  const result = diffTrees(oldTree, newTree);
  return {
    changes: result.changes,
    nodeCount: result.nodeCount,
    tier: Tier.Data,
    fallback: result.fallback,
  };
}

function diffCode(oldSource: string, newSource: string, extension: string): TierDiffResult {
  const oldTree = parseCode(oldSource, extension);
  const newTree = parseCode(newSource, extension);
  const result = diffTrees(oldTree, newTree);
  return {
    changes: result.changes,
    nodeCount: result.nodeCount,
    tier: Tier.Code,
    fallback: result.fallback,
  };
}

function markupToNodeTree(node: MarkupNode): Node {
  const children = node.children.map(markupToNodeTree);
  return createNode({
    kind: node.tag,
    label: node.attrs?.id ?? node.attrs?.class,
    value: node.text ?? undefined,
    children,
    byteRange: [0, 0],
  });
}

export interface ExtractorInfo {
  language: string;
  level: "L6" | "L5";
  extensions: string[];
}

/** Await grammar loading before listing extractors */
export function initExtractors(): Promise<void> {
  return awaitGrammars();
}

/** List all available language extractors */
export function getExtractors(): ExtractorInfo[] {
  return listExtractors();
}

/** Re-export for convenience */
export { parseData, treeFromValue } from "./data";
export { parseCode, hasGrammar } from "./code/index";

/** Will this file actually be parsed into a tree, or only line-diffed? */
export function isParseable(filePath: string): boolean {
  const info = classifyFile(filePath);
  if (info.tier === Tier.Data || info.tier === Tier.Markup) return true;
  return info.tier === Tier.Code && hasGrammar(info.extension);
}
