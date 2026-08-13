/**
 * The vocabulary a diff is reported in: four edit actions, the containment
 * chain each one carries, and the knobs that control matching.
 */

import type { Node } from "./node";

export interface InsertAction {
  type: "Insert";
  node: Node;
  parent: Node;
  position: number;
  context: NodeContext[];
}

export interface DeleteAction {
  type: "Delete";
  node: Node;
  context: NodeContext[];
}

export interface UpdateAction {
  type: "Update";
  node: Node;
  detail: RenameDetail | ValueChangeDetail;
  context: NodeContext[];
}

export interface MoveAction {
  type: "Move";
  node: Node;
  fromParent: Node;
  toParent: Node;
  fromPosition: number;
  toPosition: number;
  context: NodeContext[];
}

export type EditAction = InsertAction | DeleteAction | UpdateAction | MoveAction;

/**
 * One level of ancestry for a changed node, nearest first.
 * Lets narration say "removed function X from class Y" and lets
 * AI tooling consume the full containment chain without re-parsing.
 */
export interface NodeContext {
  kind: string;
  label?: string;
}

export interface RenameDetail {
  kind: "Renamed";
  from: string;
  to: string;
}

export interface ValueChangeDetail {
  kind: "ValueChanged";
  from?: string;
  to?: string;
}

export interface SemanticChange {
  action: EditAction;
  filePath?: string;
  fromFilePath?: string;
  toFilePath?: string;
  description: string;
}

export interface MatchOptions {
  /** Below this height, an ambiguous subtree only matches when its parent already did (default 2) */
  minHeight: number;
  /** Minimum Dice coefficient of matched descendants to pair two containers (default 0.5) */
  bottomUpRatio: number;
  /**
   * Node count beyond which diffTrees refuses to match and asks the caller
   * to line-diff instead. Defaults to Infinity: matching is linear in
   * practice and every tree size is matched for real. Embedders who know
   * their trees can be degenerate (a 1M-node chain) may set a bound here.
   */
  maxNodes: number;
}

export const DEFAULT_OPTIONS: MatchOptions = {
  minHeight: 2,
  bottomUpRatio: 0.5,
  maxNodes: Number.POSITIVE_INFINITY,
};
