/**
 * Cross-File Correlator  --  detect moves and renames across files.
 *
 * After per-file diffing, correlates deleted nodes from one file
 * with inserted nodes in another to detect cross-file moves.
 *
 * Algorithm:
 * 1. Bucket all deleted/inserted named nodes by structure_hash
 * 2. Exact content_hash or value matches → unambiguous Move
 * 3. Similarity scoring for partial matches → Move+Update
 *
 * @packageDocumentation
 */

import type { EditAction, Node } from "@ossl-dev/differens-core";
import { hashText, treesEqual } from "@ossl-dev/differens-core";

export interface CrossFileMatch {
  /** The moved node */
  node: Node;
  /** Source file path */
  fromFile: string;
  /** Destination file path */
  toFile: string;
  /** Whether the node was also modified during the move */
  modified: boolean;
  /** Similarity score (1.0 = exact match) */
  similarity: number;
  deletion: EditAction;
  insertion: EditAction;
}

export interface CrossFileResult {
  moves: CrossFileMatch[];
}

export interface FileChanges {
  filePath: string;
  actions: EditAction[];
}

export interface CorrelateOptions {
  /** Minimum similarity to consider as a move (default 0.6) */
  renameSimilarityThreshold: number;
}

const MOVABLE_KINDS = new Set([
  "file",
  "Function",
  "Method",
  "Class",
  "Interface",
  "TypeDef",
  "Enum",
  "Struct",
  "Trait",
  "Module",
  "Variable",
]);
const MAX_SIMILARITY_CANDIDATES = 64;

const DEFAULT_CORRELATE_OPTIONS: CorrelateOptions = {
  renameSimilarityThreshold: 0.6,
};

/** Only declarations and whole files can meaningfully move between files. */
export function isMoveCandidate(action: EditAction): boolean {
  if (action.type !== "Insert" && action.type !== "Delete") return false;
  const node = namedNode(action.node);
  if (!node.label || !MOVABLE_KINDS.has(node.kind)) return false;
  return (
    node.kind !== "Variable" ||
    !action.context.some((ctx) => MOVABLE_KINDS.has(ctx.kind) && ctx.kind !== "file" && ctx.label)
  );
}

/**
 * Find cross-file moves across a set of per-file diffs.
 */
export function correlate(
  fileChanges: FileChanges[],
  options: Partial<CorrelateOptions> = {},
): CrossFileResult {
  const opts = { ...DEFAULT_CORRELATE_OPTIONS, ...options };

  // Collect deleted nodes (potential move sources) and inserted nodes (potential move targets)
  const deletions: { action: EditAction; file: string }[] = [];
  const insertions: { action: EditAction; file: string }[] = [];

  for (const fc of fileChanges) {
    for (const action of fc.actions) {
      if (!isMoveCandidate(action)) continue;
      if (action.type === "Delete") {
        deletions.push({ action, file: fc.filePath });
      } else if (action.type === "Insert") {
        insertions.push({ action, file: fc.filePath });
      }
    }
  }

  // Bucket by structure_hash
  const delByStructure = new Map<number, typeof deletions>();
  const insByStructure = new Map<number, typeof insertions>();

  for (const d of deletions) {
    const h = d.action.node.structureHash;
    const list = delByStructure.get(h) ?? [];
    list.push(d);
    delByStructure.set(h, list);
  }

  for (const i of insertions) {
    const h = i.action.node.structureHash;
    const list = insByStructure.get(h) ?? [];
    list.push(i);
    insByStructure.set(h, list);
  }

  const exactInsertions = new Map<number, typeof insertions>();
  const exactKey = (node: Node) =>
    node.kind === "file" && node.value !== undefined ? hashText(node.value) : node.contentHash;
  for (const ins of insertions) {
    const key = exactKey(ins.action.node);
    const bucket = exactInsertions.get(key) ?? [];
    bucket.push(ins);
    exactInsertions.set(key, bucket);
  }
  const tokenCache = new WeakMap<Node, Set<string>>();
  const tokens = (node: Node) => {
    let set = tokenCache.get(node);
    if (!set) {
      set = new Set(tokenize(nodeText(node, node.kind !== "file")));
      tokenCache.set(node, set);
    }
    return set;
  };
  const moves: CrossFileMatch[] = [];
  const matchedDeletions = new Set<(typeof deletions)[0]>();
  const matchedInsertions = new Set<(typeof insertions)[0]>();

  // For each structure bucket, try to match deletions with insertions
  for (const [structHash, delGroup] of delByStructure) {
    const insGroup = insByStructure.get(structHash);
    if (!insGroup || insGroup.length === 0) continue;

    for (const del of delGroup) {
      if (matchedDeletions.has(del)) continue;

      // Exact content_hash match → unambiguous move
      for (const ins of exactInsertions.get(exactKey(del.action.node)) ?? []) {
        if (ins.action.node.kind !== del.action.node.kind) continue;
        if (matchedInsertions.has(ins)) continue;
        if (del.file === ins.file) continue; // skip same-file

        // Exact means exact: an equal contentHash is a candidate, not a
        // verdict (FNV is not collision-free), so the subtrees are compared
        // for real. Identical value counts as exact too: a renamed file
        // carries its path in the label, so its contentHash differs on both
        // sides even when not one byte of the content changed.
        const exact =
          treesEqual(del.action.node, ins.action.node) ||
          (del.action.node.kind === "file" &&
            del.action.node.value !== undefined &&
            del.action.node.value === ins.action.node.value);
        if (exact) {
          moves.push({
            node: namedNode(ins.action.node),
            fromFile: del.file,
            toFile: ins.file,
            modified: false,
            similarity: 1.0,
            deletion: del.action,
            insertion: ins.action,
          });
          matchedDeletions.add(del);
          matchedInsertions.add(ins);
          break;
        }
      }

      // No exact match  --  try similarity scoring
      if (!matchedDeletions.has(del)) {
        let bestIns: (typeof insertions)[0] | null = null;
        let bestScore = 0;

        const candidates =
          insGroup.length <= MAX_SIMILARITY_CANDIDATES
            ? insGroup
            : insGroup.filter(
                (ins) => namedNode(ins.action.node).label === namedNode(del.action.node).label,
              );
        if (candidates.length > MAX_SIMILARITY_CANDIDATES) continue;
        for (const ins of candidates) {
          if (matchedInsertions.has(ins)) continue;
          if (
            del.action.node.kind !== "file" &&
            namedNode(del.action.node).label !== namedNode(ins.action.node).label
          )
            continue;
          if (del.file === ins.file) continue; // skip same-file (already handled by core)

          const score = nodeSimilarity(tokens(del.action.node), tokens(ins.action.node));
          if (score > bestScore) {
            bestScore = score;
            bestIns = ins;
          }
        }

        if (bestIns && bestScore >= opts.renameSimilarityThreshold) {
          moves.push({
            node: namedNode(bestIns.action.node),
            fromFile: del.file,
            toFile: bestIns.file,
            modified: true,
            similarity: bestScore,
            deletion: del.action,
            insertion: bestIns.action,
          });
          matchedDeletions.add(del);
          matchedInsertions.add(bestIns);
        }
      }
    }
  }

  // Whatever stayed unmatched is a real delete or insert, and the per-file
  // diff already reported it as one.
  return { moves };
}

/** The node a move should be reported as: the labeled child when the
 * matched node itself is an unlabeled wrapper (Export around a Function). */
function namedNode(node: Node): Node {
  if (node.label !== undefined) return node;
  const labeled = node.children.find((c) => c.label !== undefined);
  return labeled ?? node;
}

/**
 * Compute token-level Jaccard similarity between two nodes.
 * Flattens the node tree into a bag of tokens and computes
 * the intersection/union ratio.
 */
function nodeSimilarity(setA: Set<string>, setB: Set<string>): number {
  let intersection = 0;
  const small = setA.size <= setB.size ? setA : setB;
  const large = small === setA ? setB : setA;
  for (const token of small) if (large.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Extract all text from a node tree (flattened) */
function nodeText(node: Node, includeLabel = true): string {
  const parts: string[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (includeLabel && current.label) parts.push(current.label);
    if (current.value) parts.push(current.value);
    for (const child of current.children) stack.push(child);
  }
  return parts.join(" ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 0);
}
