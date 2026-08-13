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
import { treesEqual } from "@ossl-dev/differens-core";

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

const DEFAULT_CORRELATE_OPTIONS: CorrelateOptions = {
  renameSimilarityThreshold: 0.6,
};

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
      // Only named things are worth correlating. An anonymous fragment that
      // happens to be structurally identical in two files is not a move any
      // reader recognises -- "template_substitution moved from a.ts to b.ts"
      // is noise -- and a cross-file move is always reported by name.
      // An exported top-level function moves as an unlabeled Export wrapper
      // around the labeled Function; the name is one level down.
      if (namedNode(action.node).label === undefined) continue;
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
      for (const ins of insGroup) {
        if (matchedInsertions.has(ins)) continue;
        if (del.file === ins.file) continue; // skip same-file

        // Exact means exact: an equal contentHash is a candidate, not a
        // verdict (FNV is not collision-free), so the subtrees are compared
        // for real. Identical value counts as exact too: a renamed file
        // carries its path in the label, so its contentHash differs on both
        // sides even when not one byte of the content changed.
        const exact =
          treesEqual(del.action.node, ins.action.node) ||
          (del.action.node.value !== undefined && del.action.node.value === ins.action.node.value);
        if (exact) {
          moves.push({
            node: namedNode(ins.action.node),
            fromFile: del.file,
            toFile: ins.file,
            modified: false,
            similarity: 1.0,
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

        for (const ins of insGroup) {
          if (matchedInsertions.has(ins)) continue;
          if (del.file === ins.file) continue; // skip same-file (already handled by core)

          const score = nodeSimilarity(del.action.node, ins.action.node);
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
            modified: bestScore < 1.0,
            similarity: bestScore,
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
function nodeSimilarity(a: Node, b: Node): number {
  // A whole-file node's label is its path, and a renamed file's two paths
  // differ by definition. Scoring path tokens against each other dilutes
  // the content similarity that decides whether the file was also edited:
  // a one-token edit plus a rename scored 0.54 and fell under the threshold,
  // reporting the file as deleted and re-added.
  const fileToFile = a.kind === "file" && b.kind === "file";
  const tokensA = tokenize(nodeText(a, !fileToFile));
  const tokensB = tokenize(nodeText(b, !fileToFile));

  if (tokensA.length === 0 && tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Extract all text from a node tree (flattened) */
function nodeText(node: Node, includeLabel = true): string {
  const parts: string[] = [];
  if (includeLabel && node.label) parts.push(node.label);
  if (node.value) parts.push(node.value);
  for (const child of node.children) {
    parts.push(nodeText(child, includeLabel));
  }
  return parts.join(" ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 0);
}
