/**
 * Matching: which node in the old tree is which node in the new one.
 *
 * Everything runs on flat typed arrays keyed by postorder id. A node's
 * descendants are the contiguous id range [id - size + 1, id - 1], so
 * "is X inside Y" is two integer compares instead of a Set lookup, and the
 * matching state is two Int32Arrays instead of two Maps of objects.
 *
 * Reference: Falleri et al. "Fine-grained and accurate source code
 * differencing" (ASE 2014, the GumTree paper).
 */

import type { MatchOptions } from "./actions";
import type { Node } from "./node";

/**
 * Flat postorder view of a tree. Children always have a lower id than their
 * parent, and every subtree is a contiguous id range, which is what makes
 * containment an integer compare.
 */
export interface TreeIndex {
  nodes: Node[];
  /** Postorder id of each node's parent, -1 for the root */
  parent: Int32Array;
  /** Index of each node within its parent's children */
  pos: Int32Array;
  /** Subtree node count, including the node itself */
  size: Int32Array;
  n: number;
  maxHeight: number;
}

export function indexTree(root: Node): TreeIndex {
  // DFS pushing children in forward order gives a list where each subtree is
  // contiguous and starts at its root; reversing it makes each subtree
  // contiguous and *end* at its root, which is the postorder we want.
  const order: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]!);
  }
  order.reverse();

  const n = order.length;
  const id = new Map<Node, number>();
  for (let i = 0; i < n; i++) id.set(order[i]!, i);

  const parent = new Int32Array(n).fill(-1);
  const pos = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  let maxHeight = 1;

  for (let i = 0; i < n; i++) {
    const node = order[i]!;
    if (node.height > maxHeight) maxHeight = node.height;
    const kids = node.children;
    for (let k = 0; k < kids.length; k++) {
      const cid = id.get(kids[k]!)!;
      parent[cid] = i;
      pos[cid] = k;
    }
  }
  // Children precede parents in postorder, so one ascending pass sums sizes.
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    const own = size[i]!;
    if (p >= 0) size[p]! += own;
  }

  return { nodes: order, parent, pos, size, n, maxHeight };
}

/** First descendant id of a subtree (its own id when it is a leaf). */
export function lo(idx: TreeIndex, i: number): number {
  return i - idx.size[i]! + 1;
}

export class Matching {
  oldToNew: Int32Array;
  newToOld: Int32Array;

  constructor(oldN: number, newN: number) {
    this.oldToNew = new Int32Array(oldN).fill(-1);
    this.newToOld = new Int32Array(newN).fill(-1);
  }

  link(i: number, j: number): void {
    if (this.oldToNew[i]! >= 0 || this.newToOld[j]! >= 0) return;
    this.oldToNew[i] = j;
    this.newToOld[j] = i;
  }
}

/**
 * Match the largest identical subtrees first, wherever they sit in either
 * tree. Position is only a tie-breaker, so a function that moved to the
 * other end of the file still matches its old self instead of showing up
 * as a delete plus an add.
 */
export function topDownMatch(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
  opts: MatchOptions,
): void {
  const maxH = Math.max(oldIdx.maxHeight, newIdx.maxHeight);
  // Height buckets instead of a priority queue: heights are small integers
  // and a node's children always land in a strictly lower bucket, so one
  // descending sweep visits every node at most once.
  const oldB: number[][] = Array.from({ length: maxH + 1 }, () => []);
  const newB: number[][] = Array.from({ length: maxH + 1 }, () => []);
  oldB[oldIdx.nodes[oldIdx.n - 1]!.height]!.push(oldIdx.n - 1);
  newB[newIdx.nodes[newIdx.n - 1]!.height]!.push(newIdx.n - 1);

  const byHash = new Map<number, number[]>();

  for (let h = maxH; h >= 1; h--) {
    const A = oldB[h]!;
    const B = newB[h]!;

    if (A.length > 0 && B.length > 0) {
      byHash.clear();
      for (const j of B) {
        if (m.newToOld[j]! >= 0) continue;
        const key = newIdx.nodes[j]!.contentHash;
        const list = byHash.get(key);
        if (list) list.push(j);
        else byHash.set(key, [j]);
      }

      for (const i of A) {
        if (m.oldToNew[i]! >= 0) continue;
        const oldNode = oldIdx.nodes[i]!;
        const candidates = byHash.get(oldNode.contentHash);
        if (!candidates) continue;

        let best = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let ambiguous = false;
        for (const j of candidates) {
          if (m.newToOld[j]! >= 0) continue;
          if (newIdx.nodes[j]!.kind !== oldNode.kind) continue;
          // Equal hash is not proof of equal tree. Verify before trusting it,
          // so a collision degrades to "no match" rather than to two unrelated
          // subtrees being welded together.
          if (!isomorphic(oldIdx, newIdx, i, j)) continue;
          const score = affinity(oldIdx, newIdx, m, i, j);
          if (best >= 0) ambiguous = true;
          if (score > bestScore) {
            bestScore = score;
            best = j;
          }
        }
        if (best < 0) continue;

        // A short subtree that could pair with several identical ones is
        // exactly the "two `x` in a ternary" case: only accept it when the
        // parents are already paired, otherwise leave it to the edit script.
        if (ambiguous && h < opts.minHeight) {
          const pi = oldIdx.parent[i]!;
          const pj = newIdx.parent[best]!;
          if (pi < 0 || pj < 0 || m.oldToNew[pi]! !== pj) continue;
        }

        linkSubtree(oldIdx, newIdx, m, i, best);
      }
    }

    // Anything still unmatched hands its children to the next lower bucket.
    for (const i of A) {
      if (m.oldToNew[i]! < 0) pushChildren(oldIdx, i, oldB);
    }
    for (const j of B) {
      if (m.newToOld[j]! < 0) pushChildren(newIdx, j, newB);
    }
  }
}

function pushChildren(idx: TreeIndex, i: number, buckets: number[][]): void {
  const kids = idx.nodes[i]!.children;
  if (kids.length === 0) return;
  // Children of i occupy [lo(i), i-1] and each child's own subtree is
  // contiguous, so walk the range backwards one subtree at a time.
  let c = i - 1;
  const start = lo(idx, i);
  while (c >= start) {
    buckets[idx.nodes[c]!.height]!.push(c);
    c -= idx.size[c]!;
  }
}

/** Prefer the candidate whose parent already matched, then the closest position. */
function affinity(oldIdx: TreeIndex, newIdx: TreeIndex, m: Matching, i: number, j: number): number {
  const pi = oldIdx.parent[i]!;
  const pj = newIdx.parent[j]!;
  let score = 0;
  if (pi >= 0 && pj >= 0) {
    if (m.oldToNew[pi]! === pj) score += 8;
    else if (oldIdx.nodes[pi]!.kind === newIdx.nodes[pj]!.kind) score += 1;
  }
  return score - Math.min(8, Math.abs(oldIdx.pos[i]! - newIdx.pos[j]!)) * 0.1;
}

/** Same shape and same kinds throughout: the check behind an equal hash. */
function isomorphic(oldIdx: TreeIndex, newIdx: TreeIndex, i: number, j: number): boolean {
  const size = oldIdx.size[i]!;
  if (newIdx.size[j] !== size) return false;
  const oi = lo(oldIdx, i);
  const oj = lo(newIdx, j);
  for (let k = 0; k < size; k++) {
    if (oldIdx.nodes[oi + k]!.kind !== newIdx.nodes[oj + k]!.kind) return false;
  }
  return true;
}

/** Map two isomorphic subtrees node for node; their postorder ranges align 1:1. */
function linkSubtree(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
  i: number,
  j: number,
): void {
  const size = oldIdx.size[i]!;
  const oi = lo(oldIdx, i);
  const oj = lo(newIdx, j);
  for (let k = 0; k < size; k++) m.link(oi + k, oj + k);
}

/**
 * Pair the containers that survived phase 1 by how many descendants they
 * already share (Dice coefficient).
 *
 * Candidates are not "every unmatched node of the same kind" -- that is the
 * quadratic trap. They are the unmatched ancestors of nodes that already
 * matched something inside this container, so a container is only ever
 * compared against the handful of places its contents actually went.
 */
const MAX_CANDIDATES = 4;

export function bottomUpMatch(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
  opts: MatchOptions,
): void {
  // Stamped scratch arrays: reused across every container, so candidate
  // bookkeeping allocates nothing per node.
  // ponytail: 4 candidates is plenty in practice; raise it if a container
  // ever loses its true partner to a sibling that merely ranked higher.
  const stamp = new Int32Array(newIdx.n).fill(-1);
  const common = new Int32Array(newIdx.n);
  const candidates: number[] = [];

  // Ascending postorder = children before parents, so a container sees every
  // match its subtree made. One pass, no fixpoint rounds needed.
  for (let i = 0; i < oldIdx.n; i++) {
    if (m.oldToNew[i]! >= 0) continue;
    const size = oldIdx.size[i]!;
    if (size <= 1) continue; // leaves carry no descendant evidence

    const kind = oldIdx.nodes[i]!.kind;
    const start = lo(oldIdx, i);
    candidates.length = 0;

    for (let d = start; d < i; d++) {
      const j = m.oldToNew[d]!;
      if (j < 0) continue;
      // Walk up from the partner until an already-matched ancestor: those
      // are the only containers that could still claim this descendant.
      let a = newIdx.parent[j]!;
      while (a >= 0 && m.newToOld[a]! < 0) {
        if (newIdx.nodes[a]!.kind === kind) {
          if (stamp[a]! !== i) {
            stamp[a] = i;
            common[a] = 0;
            candidates.push(a);
          }
          common[a]!++;
        }
        a = newIdx.parent[a]!;
      }
    }

    if (candidates.length === 0) continue;
    // The walk-up counts undercount whenever a matched container sits between
    // a descendant and the candidate, so they only rank candidates. Score the
    // few survivors exactly.
    if (candidates.length > MAX_CANDIDATES) {
      candidates.sort((a, b) => common[b]! - common[a]!);
      candidates.length = MAX_CANDIDATES;
    }

    let best = -1;
    let bestDice = 0;
    for (const c of candidates) {
      const denom = size - 1 + newIdx.size[c]! - 1;
      if (denom <= 0) continue;
      const dice = (2 * exactCommon(oldIdx, newIdx, m, i, c)) / denom;
      if (dice > bestDice) {
        bestDice = dice;
        best = c;
      }
    }

    // A same-kind root with any matched descendant is the same file. Without
    // this, adding or removing one top-level function in a small file pairs
    // nothing, the unmatched root absorbs the whole change, and the report
    // says "removed file" instead of naming the function.
    const isRoot = oldIdx.parent[i]! < 0;
    if (best >= 0 && (isRoot ? bestDice > 0 : bestDice >= opts.bottomUpRatio)) m.link(i, best);
  }
}

/** Descendants of `i` whose partner lands inside the subtree of `c`. */
function exactCommon(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
  i: number,
  c: number,
): number {
  const from = lo(newIdx, c);
  let count = 0;
  for (let d = lo(oldIdx, i); d < i; d++) {
    const j = m.oldToNew[d]!;
    if (j >= from && j < c) count++;
  }
  return count;
}

/** Cap on the pairwise alignment table; past this, zip by position instead. */
const MAX_ALIGN = 64;

/**
 * Pair up leftover leaves inside an already-matched parent.
 *
 * `const a = 1` becoming `const a = 2` leaves both number literals unmatched:
 * their hashes differ and a leaf has no descendants for the Dice test to work
 * with. Without this pass the most ordinary edit there is gets reported as a
 * deletion plus an addition instead of "changed 1 to 2".
 *
 * Deliberately limited to childless nodes. Containers have the Dice test;
 * letting them pair here would turn "removed function a, added function b"
 * into a bogus rename.
 */
export function recoverLeaves(oldIdx: TreeIndex, newIdx: TreeIndex, m: Matching): void {
  for (let i = 0; i < oldIdx.n; i++) {
    const j = m.oldToNew[i]!;
    if (j < 0 || oldIdx.size[i] === 1) continue;

    const a = unmatchedLeafChildren(oldIdx, m.oldToNew, i);
    if (a.length === 0) continue;
    const b = unmatchedLeafChildren(newIdx, m.newToOld, j);
    if (b.length === 0) continue;

    if (a.length > MAX_ALIGN || b.length > MAX_ALIGN) {
      const n = Math.min(a.length, b.length);
      for (let k = 0; k < n; k++) {
        if (oldIdx.nodes[a[k]!]!.kind === newIdx.nodes[b[k]!]!.kind) m.link(a[k]!, b[k]!);
      }
      continue;
    }

    // LCS over kinds so an inserted or removed sibling shifts the rest
    // rather than smearing every later leaf into a false pairing.
    const table: number[][] = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let x = a.length - 1; x >= 0; x--) {
      for (let y = b.length - 1; y >= 0; y--) {
        table[x]![y] =
          oldIdx.nodes[a[x]!]!.kind === newIdx.nodes[b[y]!]!.kind
            ? table[x + 1]![y + 1]! + 1
            : Math.max(table[x + 1]![y]!, table[x]![y + 1]!);
      }
    }
    let x = 0;
    let y = 0;
    while (x < a.length && y < b.length) {
      if (oldIdx.nodes[a[x]!]!.kind === newIdx.nodes[b[y]!]!.kind) {
        m.link(a[x]!, b[y]!);
        x++;
        y++;
      } else if (table[x + 1]![y]! >= table[x]![y + 1]!) x++;
      else y++;
    }
  }
}

/**
 * Pair unmatched containers whose structure hashes agree, one to one.
 *
 * A change confined to a leaf value leaves no matched descendants anywhere,
 * so the Dice test has no evidence and even the roots never pair:
 * `{port: 1}` vs `{port: 2}` reports the whole object deleted and re-added.
 * Structure hashes ignore values and labels, so containers that survived a
 * pure value edit agree on them. Pair the unique agreements, then run leaf
 * recovery again to produce the ValueChanged pairing underneath.
 */
export function recoverContainers(oldIdx: TreeIndex, newIdx: TreeIndex, m: Matching): void {
  const byStruct = new Map<number, number[]>();
  for (let j = 0; j < newIdx.n; j++) {
    if (m.newToOld[j]! >= 0) continue;
    const node = newIdx.nodes[j]!;
    if (node.children.length === 0) continue; // leaves: value edits pair below, not here
    const list = byStruct.get(node.structureHash);
    if (list) list.push(j);
    else byStruct.set(node.structureHash, [j]);
  }

  for (let i = 0; i < oldIdx.n; i++) {
    if (m.oldToNew[i]! >= 0) continue;
    const node = oldIdx.nodes[i]!;
    if (node.children.length === 0) continue;
    const candidates = byStruct.get(node.structureHash);
    if (!candidates) continue;

    // Unique and still unclaimed, or the pairing is a guess.
    let only = -1;
    for (const j of candidates) {
      if (m.newToOld[j]! >= 0) continue;
      if (newIdx.nodes[j]!.kind !== node.kind) continue;
      if (only >= 0) {
        only = -1;
        break;
      }
      only = j;
    }
    if (only >= 0) m.link(i, only);
  }
}

/** Childless, still-unmatched children of `i`, in source order. */
function unmatchedLeafChildren(idx: TreeIndex, matched: Int32Array, i: number): number[] {
  const out: number[] = [];
  let c = i - 1;
  const start = lo(idx, i);
  while (c >= start) {
    if (idx.size[c] === 1 && matched[c]! < 0) out.push(c);
    c -= idx.size[c]!;
  }
  out.reverse(); // the scan walks children right to left
  return out;
}
