/**
 * Differens Core: GumTree-style tree matching for semantic diffing.
 *
 * Pipeline: index -> greedy top-down isomorphic match -> bottom-up
 * container match -> Chawathe edit script with minimal Move set.
 *
 * Reference: Falleri et al. "Fine-grained and accurate source code
 * differencing" (ASE 2014, the GumTree paper).
 *
 * Everything below runs on flat typed arrays keyed by postorder id.
 * A node's descendants are the contiguous id range [id - size + 1, id - 1],
 * so "is X inside Y" is two integer compares instead of a Set lookup, and
 * the matching state is two Int32Arrays instead of two Maps of objects.
 */

// 32-bit FNV-1a via Math.imul (single-instruction multiply, no BigInt:
// BigInt arithmetic is 80-90% slower in JS engines). Two independent
// streams are folded into one 53-bit-safe hash: hi * 2^21 + lo.
// Effective entropy is 53 bits, so the birthday bound at 50k nodes is
// ~1e-7 instead of 32-bit's ~30%. Collision means wrongly matching
// different subtrees as identical, which is why we keep the width.
const FNV_PRIME = 0x01000193;
const MIX_PRIME = 0x85ebca6b;
const FNV_SEED_A = 0x811c9dc5;
const FNV_SEED_B = 0x01000193;

function hashFnv(seed: number, byte: number): number {
  return Math.imul(seed ^ byte, FNV_PRIME) >>> 0;
}

function hashStr(seed: number, str: string): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = hashFnv(h, str.charCodeAt(i));
  return h;
}

/**
 * Absorb a full 32-bit word, not a byte. Child hashes are mixed with this:
 * feeding them through hashFnv a byte at a time would only carry 8 bits of
 * the child into the parent, so two different children agreeing on one byte
 * would produce the same parent hash and be matched as identical subtrees.
 */
function mixWord(h: number, word: number, prime: number): number {
  const x = Math.imul(h ^ word, prime) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

/** Fold two 32-bit streams into one 53-bit-safe hash. */
function fold(hA: number, hB: number): number {
  return hA * 0x200000 + (hB & 0x1fffff);
}

/** Split a folded hash back into its two contributing words. */
function foldHi(h: number): number {
  return Math.floor(h / 0x200000);
}
function foldLo(h: number): number {
  return h % 0x200000;
}

// ---------- Node ----------

/** Position in source text */
export interface Position {
  row: number;
  column: number;
}

/** Byte range in source text */
export type ByteRange = [start: number, end: number];

export interface Node {
  kind: string;
  label?: string;
  value?: string;
  children: Node[];
  byteRange: ByteRange;
  height: number;
  contentHash: number;
  structureHash: number;
}

/** Options for building a Node tree */
export interface BuildNodeOptions {
  kind: string;
  label?: string;
  value?: string;
  children?: Node[];
  byteRange: ByteRange;
}

export function createNode(opts: BuildNodeOptions): Node {
  const children = opts.children ?? [];
  let maxChildHeight = 0;
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.height > maxChildHeight) maxChildHeight = children[i]!.height;
  }
  const height = maxChildHeight + 1;

  // Merkle hash: contentHash covers kind + label + value + children's contentHash.
  // Two streams: A mixes kind/label/value bytes, B mixes the children's hashes,
  // so a child change flips B while a value change flips A.
  let hA = hashStr(FNV_SEED_A, opts.kind);
  let hB = hashStr(FNV_SEED_B, opts.kind);
  if (opts.label !== undefined) { hA = hashStr(hA, opts.label); hB = hashStr(hB, opts.label); }
  if (opts.value !== undefined) { hA = hashStr(hA, opts.value); hB = hashStr(hB, opts.value); }
  for (let i = 0; i < children.length; i++) {
    const h = children[i]!.contentHash;
    hA = mixWord(hA, foldHi(h), FNV_PRIME);
    hA = mixWord(hA, foldLo(h), MIX_PRIME);
    hB = mixWord(hB, foldLo(h), FNV_PRIME);
    hB = mixWord(hB, foldHi(h), MIX_PRIME);
  }
  const contentHash = fold(hA, hB);

  // structureHash covers kind + children's structureHash, ignores label/value
  let sA = hashStr(FNV_SEED_A, opts.kind);
  let sB = hashStr(FNV_SEED_B, opts.kind);
  for (let i = 0; i < children.length; i++) {
    const h = children[i]!.structureHash;
    sA = mixWord(sA, foldHi(h), FNV_PRIME);
    sA = mixWord(sA, foldLo(h), MIX_PRIME);
    sB = mixWord(sB, foldLo(h), FNV_PRIME);
    sB = mixWord(sB, foldHi(h), MIX_PRIME);
  }
  const structureHash = fold(sA, sB);

  return { kind: opts.kind, label: opts.label, value: opts.value, children,
           byteRange: opts.byteRange, height, contentHash, structureHash };
}

// ---------- Edit actions ----------

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

// ---------- Semantic change ----------

export interface SemanticChange {
  action: EditAction;
  filePath?: string;
  fromFilePath?: string;
  toFilePath?: string;
  description: string;
}

// ---------- Matching options ----------

export interface MatchOptions {
  /** Below this height, an ambiguous subtree only matches when its parent already did (default 2) */
  minHeight: number;
  /** Minimum Dice coefficient of matched descendants to pair two containers (default 0.5) */
  bottomUpRatio: number;
  /** Maximum file size in bytes before falling back to line diff (default 5MB) */
  maxFileSize: number;
  /** Maximum node count before falling back to line diff (default 250_000) */
  maxNodes: number;
}

export const DEFAULT_OPTIONS: MatchOptions = {
  minHeight: 2,
  bottomUpRatio: 0.5,
  maxFileSize: 5 * 1024 * 1024,
  // Matching is linear now (350k nodes in ~70ms), so the old 50k ceiling was
  // sending ordinary large files to a line diff for no reason. This limit is
  // about memory, not time.
  maxNodes: 250_000,
};

// ---------- Tree index ----------

/**
 * Flat postorder view of a tree. Children always have a lower id than their
 * parent, and every subtree is a contiguous id range, which is what makes
 * containment an integer compare.
 */
interface TreeIndex {
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

function indexTree(root: Node): TreeIndex {
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
    if (p >= 0) size[p]! += size[i]!;
  }

  return { nodes: order, parent, pos, size, n, maxHeight };
}

/** First descendant id of a subtree (its own id when it is a leaf). */
function lo(idx: TreeIndex, i: number): number {
  return i - idx.size[i]! + 1;
}

// ---------- Matching state ----------

class Matching {
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

// ---------- Phase 1: greedy top-down ----------

/**
 * Match the largest identical subtrees first, wherever they sit in either
 * tree. Position is only a tie-breaker, so a function that moved to the
 * other end of the file still matches its old self instead of showing up
 * as a delete plus an add.
 */
function topDownMatch(
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
        let bestScore = -Infinity;
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
function affinity(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  m: Matching,
  i: number,
  j: number,
): number {
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
function isomorphic(
  oldIdx: TreeIndex,
  newIdx: TreeIndex,
  i: number,
  j: number,
): boolean {
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

// ---------- Phase 2: bottom-up container matching ----------

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

function bottomUpMatch(
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

    if (best >= 0 && bestDice >= opts.bottomUpRatio) m.link(i, best);
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

// ---------- Phase 2.5: leaf recovery ----------

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
function recoverLeaves(oldIdx: TreeIndex, newIdx: TreeIndex, m: Matching): void {
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
        table[x]![y] = oldIdx.nodes[a[x]!]!.kind === newIdx.nodes[b[y]!]!.kind
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

// ---------- Phase 3: edit script ----------

function generateEditScript(
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

// ---------- Main diff API ----------

export interface DiffResult {
  changes: EditAction[];
  /** Whether the pipeline fell back to a simpler mode */
  fallback?: "bytes" | "lines" | "generic_tree";
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

// ---------- Utility: short-circuit hash comparison ----------

/**
 * Quick check: are two byte streams identical?
 * Use this before parsing to skip the full diff pipeline.
 */
export function fastUnchanged(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): boolean {
  if (oldBytes.length !== newBytes.length) return false;
  // Word-at-a-time over the aligned middle: 4x fewer iterations, and the
  // whole point of this function is to bail before any parsing happens.
  const len = oldBytes.length;
  const head = oldBytes.byteOffset % 4 === newBytes.byteOffset % 4 ? (4 - (oldBytes.byteOffset % 4)) % 4 : len;
  const limit = Math.min(head, len);
  for (let i = 0; i < limit; i++) {
    if (oldBytes[i] !== newBytes[i]) return false;
  }
  const words = (len - limit) >> 2;
  if (words > 0) {
    const a = new Uint32Array(oldBytes.buffer, oldBytes.byteOffset + limit, words);
    const b = new Uint32Array(newBytes.buffer, newBytes.byteOffset + limit, words);
    for (let i = 0; i < words; i++) {
      if (a[i] !== b[i]) return false;
    }
  }
  for (let i = limit + (words << 2); i < len; i++) {
    if (oldBytes[i] !== newBytes[i]) return false;
  }
  return true;
}

// ---------- Utility: node tree from simple key-value ----------

/**
 * Build a simple tree from a flat key-value object.
 * Used by T4 (config/data tier) for JSON/YAML value trees.
 */
export function treeFromValue(
  value: unknown,
  kind = "root",
): Node {
  if (value === null || value === undefined) {
    return createNode({
      kind,
      value: String(value),
      byteRange: [0, 1],
    });
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return createNode({
      kind: "leaf",
      label: kind,
      value: String(value),
      byteRange: [0, String(value).length],
    });
  }

  if (Array.isArray(value)) {
    const children = value.map((item, i) =>
      treeFromValue(item, `${kind}[${i}]`),
    );
    return createNode({
      kind: "array",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  if (typeof value === "object") {
    const children: Node[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      children.push(treeFromValue(val, key));
    }
    return createNode({
      kind: "object",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  return createNode({
    kind,
    value: String(value),
    byteRange: [0, 1],
  });
}
