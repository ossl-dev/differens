/**
 * Differens core: semantic diff of two node trees.
 *
 * parse -> match (GumTree lineage) -> edit script with a minimal Move set.
 * Adapters in @differens/tiers turn source into Nodes and call diffTrees.
 */

import type { EditAction, MatchOptions } from "./actions";
import { DEFAULT_OPTIONS } from "./actions";
import type { Node } from "./node";
import { bottomUpMatch, indexTree, Matching, recoverLeaves, topDownMatch } from "./match";
import { generateEditScript } from "./edit-script";

export * from "./node";
export * from "./actions";

export interface DiffResult {
  changes: EditAction[];
  /** Set when the trees were too large to match and the caller should line-diff */
  fallback?: "lines";
  /** Total nodes processed */
  nodeCount: number;
}

/**
 * Diff two Node trees using the GumTree-style matching algorithm.
 *
 * This is the main entry point for the diff core. Tier adapters parse
 * source into Nodes, then call this function to produce typed edit actions.
 */
export function diffTrees(
  oldRoot: Node,
  newRoot: Node,
  options: Partial<MatchOptions> = {},
): DiffResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const oldIdx = indexTree(oldRoot);
  const newIdx = indexTree(newRoot);
  const nodeCount = oldIdx.n + newIdx.n;

  // Safety valve: skip tree diff on enormous inputs
  if (oldIdx.n > opts.maxNodes || newIdx.n > opts.maxNodes) {
    return { changes: [], fallback: "lines", nodeCount };
  }

  const m = new Matching(oldIdx.n, newIdx.n);
  topDownMatch(oldIdx, newIdx, m, opts);
  bottomUpMatch(oldIdx, newIdx, m, opts);
  recoverLeaves(oldIdx, newIdx, m);

  return { changes: generateEditScript(oldIdx, newIdx, m), nodeCount };
}