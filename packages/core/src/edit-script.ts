/**
 * Turning a matching into the list of edits that explains it.
 */

import type { EditAction, NodeContext } from "./actions";
import { lo, type Matching, type TreeIndex } from "./match";

export function generateEditScript(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
): EditAction[] {
  const updates: EditAction[] = [];
  const moves: EditAction[] = [];
  const deletes: EditAction[] = [];
  const inserts: EditAction[] = [];

  // Candidate reorders grouped by parent pair, resolved with an LIS below:
  // renaming one sibling must not report every sibling after it as moved.
  const reorder = new Map<number, { i: number; j: number }[]>();

  for (let i = 0; i < oldIdx.n; i++) {
    const j = m.oldToNew[i]!;
    if (j < 0) continue;

    const oldNode = oldIdx.nodes[i]!;
    const newNode = newIdx.nodes[j]!;

    if (oldNode.label !== newNode.label || oldNode.value !== newNode.value) {
      const ctx = ancestryChain(newIdx, j);
      if (oldNode.label !== newNode.label) {
        updates.push({
          type: "Update",
          node: newNode,
          detail: {
            kind: "Renamed",
            from: oldNode.label ?? "unnamed",
            to: newNode.label ?? "unnamed",
          },
          context: ctx,
        });
      }
      if (oldNode.value !== newNode.value) {
        updates.push({
          type: "Update",
          node: newNode,
          detail: { kind: "ValueChanged", from: oldNode.value, to: newNode.value },
          context: ctx,
        });
      }
    }

    const pi = oldIdx.parent[i]!;
    const pj = newIdx.parent[j]!;
    if (pi < 0 || pj < 0) continue;

    if (m.oldToNew[pi]! !== pj) {
      // Only a genuine relocation if both containers survived. When the old
      // parent is being deleted or the new one inserted, the node's new home
      // is already explained by that Delete or Insert, and reporting a Move
      // as well buried real changes under hundreds of lines about literals
      // that happen to appear in two rewritten branches.
      if (m.oldToNew[pi]! < 0 || m.newToOld[pj]! < 0) continue;

      moves.push({
        type: "Move",
        node: newNode,
        fromParent: oldIdx.nodes[pi]!,
        toParent: newIdx.nodes[pj]!,
        fromPosition: oldIdx.pos[i]!,
        toPosition: newIdx.pos[j]!,
        context: ancestryChain(newIdx, j),
      });
    } else {
      const group = reorder.get(pi);
      if (group) group.push({ i, j });
      else reorder.set(pi, [{ i, j }]);
    }
  }

  for (const [pi, group] of reorder) {
    if (group.length < 2) continue;
    group.sort((a, b) => oldIdx.pos[a.i]! - oldIdx.pos[b.i]!);
    const seq = group.map((g) => newIdx.pos[g.j]!);
    const keep = longestIncreasingSubsequence(seq);
    for (let k = 0; k < group.length; k++) {
      if (keep.has(k)) continue;
      const { i, j } = group[k]!;
      moves.push({
        type: "Move",
        node: newIdx.nodes[j]!,
        fromParent: oldIdx.nodes[pi]!,
        toParent: newIdx.nodes[newIdx.parent[j]!]!,
        fromPosition: oldIdx.pos[i]!,
        toPosition: newIdx.pos[j]!,
        context: ancestryChain(newIdx, j),
      });
    }
  }

  // Deletes and inserts are both subtree-absorbing: one action for a removed
  // or added function, not one per token inside it.
  for (let i = oldIdx.n - 1; i >= 0; i--) {
    if (m.oldToNew[i]! >= 0) continue;
    const p = oldIdx.parent[i]!;
    if (p >= 0 && m.oldToNew[p]! < 0) continue; // covered by an ancestor's Delete
    deletes.push({
      type: "Delete",
      node: oldIdx.nodes[i]!,
      context: ancestryChain(oldIdx, i),
    });
  }

  // Parents come after children in postorder, so descending visits a parent
  // before its children and `covered` is always known by the time it is read.
  const covered = new Uint8Array(newIdx.n);
  for (let j = newIdx.n - 1; j >= 0; j--) {
    if (m.newToOld[j]! >= 0) continue;
    const p = newIdx.parent[j]!;
    // An unmatched root has no parent to be inserted into, so it is not
    // emitted -- and therefore does not cover its children either.
    if (p < 0) continue;
    if (covered[p]) {
      covered[j] = 1;
      continue;
    }
    covered[j] = 1;
    inserts.push({
      type: "Insert",
      node: newIdx.nodes[j]!,
      parent: newIdx.nodes[p]!,
      position: newIdx.pos[j]!,
      context: ancestryChain(newIdx, j),
    });
  }

  return [...updates, ...moves, ...deletes, ...inserts];
}

/** Indices of one longest increasing subsequence of seq. O(n log n). */
function longestIncreasingSubsequence(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Int32Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k]!;
  }
  return keep;
}

/**
 * Build the ancestry chain for a node, nearest ancestor first.
 * Root is excluded (it's just the file wrapper).
 */
function ancestryChain(idx: TreeIndex, i: number): NodeContext[] {
  const chain: NodeContext[] = [];
  let current = idx.parent[i]!;
  while (current >= 0) {
    const node = idx.nodes[current]!;
    chain.push({ kind: node.kind, label: node.label });
    current = idx.parent[current]!;
  }
  return chain;
}