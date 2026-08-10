/**
 * Tier Adapters  --  parse files into Node trees for the diff core.
 *
 * The content router picks a tier based on file extension and magic bytes,
 * then delegates to the appropriate adapter. Each adapter produces a Node
 * tree that feeds into @differens/core's matching algorithm.
 *
 * @packageDocumentation
 */

import type { Node } from "@differens/core";
import { createNode, diffTrees, fastUnchanged } from "@differens/core";
import { diffLines } from "./raw";
import { diffWords } from "./prose";
import { parseMarkup, type MarkupNode } from "./markup";
import { parseData } from "./data";
import { parseCode, listExtractors, awaitGrammars } from "./code/index";
import { isBinaryExtension } from "./binary";

// ---------- Tier enum ----------

export enum Tier {
  Binary = 0,
  Raw = 1,
  Prose = 2,
  Markup = 3,
  Data = 4,
  Code = 5,
  Composite = 6,
}

// ---------- File classification ----------

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
    "rs", "c", "cpp", "h", "hpp", "go", "java", "kt", "py", "rb",
    "php", "swift", "cs", "js", "mjs", "cjs", "ts", "jsx", "tsx",
    "scala", "lua", "sh", "sql", "bash", "zsh", "fish", "css", "scss",
    "less", "vue", "svelte", "astro",
  ];
  if (codeExts.includes(ext)) {
    return { path: filePath, extension: ext, tier: Tier.Code };
  }

  // Default: raw diff
  return { path: filePath, extension: ext, tier: Tier.Raw };
}

// ---------- Diff options ----------

export interface TierDiffOptions {
  oldSource: string;
  newSource: string;
  oldPath: string;
  newPath: string;
  language?: string;
}

// ---------- Main diff pipeline ----------

export interface TierDiffResult {
  changes: import("@differens/core").EditAction[];
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
  _newPath: string,
): TierDiffResult {
  // Quick hash short-circuit
  const oldBytes = new TextEncoder().encode(oldSource);
  const newBytes = new TextEncoder().encode(newSource);
  const info = classifyFile(oldPath);
  if (fastUnchanged(oldBytes, newBytes)) {
    return { changes: [], nodeCount: 0, tier: info.tier };
  }

  // Binary sniff: NUL bytes or failed UTF-8 decode (replacement chars).
  // Handles .dat, .bin without extension lists, git blobs, etc.
  if (
    info.tier === Tier.Raw &&
    (hasNullByte(oldBytes) || hasNullByte(newBytes) ||
     oldSource.includes("�") || newSource.includes("�"))
  ) {
    return diffBinary(oldSource, newSource);
  }

  switch (info.tier) {
    case Tier.Binary:
      return diffBinary(oldSource, newSource);

    case Tier.Data:
      try {
        return diffData(oldSource, newSource);
      } catch {
        // Fall through to raw diff
      }
      break;

    case Tier.Markup:
      try {
        return diffMarkup(oldSource, newSource);
      } catch {
        // Fall through to raw diff
      }
      break;

    case Tier.Prose:
      try {
        return diffProse(oldSource, newSource);
      } catch {
        // Fall through to raw diff
      }
      break;

    case Tier.Code:
      try {
        return diffCode(oldSource, newSource, info.extension);
      } catch {
        // Fall through to raw diff
      }
      break;

    case Tier.Composite:
      try {
        return diffCode(oldSource, newSource, info.extension);
      } catch {
        // Fall through
      }
      break;
  }

  // Raw fallback
  return diffRaw(oldSource, newSource);
}

function hasNullByte(bytes: Uint8Array): boolean {
  // First 8KB is plenty for a sniff
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

// ---------- Tier implementations ----------

function diffBinary(oldSource: string, newSource: string): TierDiffResult {
  return {
    changes: [{
      type: "Update" as const,
      context: [],
      node: createNode({ kind: "binary_file", byteRange: [0, oldSource.length] }),
      detail: {
        kind: "ValueChanged" as const,
        from: `${oldSource.length} bytes`,
        to: `${newSource.length} bytes`,
      },
    }],
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
  return { changes: result.changes, nodeCount: result.nodeCount, tier: Tier.Markup };
}

function diffData(oldSource: string, newSource: string): TierDiffResult {
  const oldTree = parseData(oldSource);
  const newTree = parseData(newSource);
  const result = diffTrees(oldTree, newTree);
  return { changes: result.changes, nodeCount: result.nodeCount, tier: Tier.Data };
}

function diffCode(
  oldSource: string,
  newSource: string,
  extension: string,
): TierDiffResult {
  const oldTree = parseCode(oldSource, extension);
  const newTree = parseCode(newSource, extension);
  const result = diffTrees(oldTree, newTree);
  return { changes: result.changes, nodeCount: result.nodeCount, tier: Tier.Code };
}

// ---------- Markup node conversion ----------

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

// ---------- Public introspection API ----------

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
export { parseCode } from "./code/index";
