/**
 * Sequence diff shared by the raw (line) and prose (word) tiers.
 *
 * Layers, in order:
 * 1. Identical head and tail are trimmed: they are the overwhelming majority
 *    of any real edit and contribute nothing to the diff.
 * 2. Small middles (<= 2000 x 2000) get an exact LCS in a Uint16 table.
 * 3. Anything larger gets Myers O(ND) with divide and conquer (Myers 1986,
 *    section 4b, the linear-space refinement; structure follows the canonical
 *    diff-match-patch bisect): linear memory, time O((n+m) * d) where d is
 *    the actual number of edits. The round budget scales with input size,
 *    not a fixed line cap, so arbitrarily large files diff for real.
 * 4. If the budget runs out (pathological edit density: a big region where
 *    most lines changed), each position is compared pairwise. Always
 *    correct, just verbose. No input size is ever refused.
 */

export interface SeqOp {
  type: "Insert" | "Delete" | "Equal";
  text: string;
}

export interface HunkDiff {
  type: "Insert" | "Delete" | "Update";
  text: string;
  oldText?: string;
  newText?: string;
}

/** 2000 x 2000 Uint16 = 8MB; past this the table is not worth its memory. */
const TABLE_MAX = 2_000;

/** Cap on total work across the whole recursion: about 2e8 compares. */
const OPS_BUDGET = 2e8;

/**
 * Diff two token sequences into an ordered Insert/Delete/Equal stream.
 * The identical head and tail are trimmed and not reported; callers only
 * need the middle, which is where every change lives.
 */
export function diffSequences(a: string[], b: string[], join = "\n"): SeqOp[] {
  let head = 0;
  const shortest = Math.min(a.length, b.length);
  while (head < shortest && a[head] === b[head]) head++;

  let tail = 0;
  while (tail < shortest - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }

  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length === 0 && bm.length === 0) return [];

  if (am.length <= TABLE_MAX && bm.length <= TABLE_MAX) {
    return lcsTable(am, bm);
  }

  // A middle where no token survives on both sides is a rewrite. One Update
  // says that; a diff of 20k lines that all changed says it worse and pays
  // the Myers budget to get there.
  if (am.length > TABLE_MAX || bm.length > TABLE_MAX) {
    const seen = new Set(am);
    let shared = false;
    for (let i = 0; i < bm.length; i++) {
      if (seen.has(bm[i]!)) {
        shared = true;
        break;
      }
    }
    if (!shared) {
      return [
        { type: "Delete", text: am.join(join) },
        { type: "Insert", text: bm.join(join) },
      ];
    }
  }

  const ops: SeqOp[] = [];
  if (myersSplit(am, bm, 0, am.length, 0, bm.length, OPS_BUDGET, ops)) {
    return ops;
  }
  return zipFallback(am, bm, join);
}

/** Exact LCS on a Uint16 table. O(n*m), bounded by TABLE_MAX on both sides. */
function lcsTable(a: string[], b: string[]): SeqOp[] {
  const n = a.length;
  const m = b.length;

  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const temp: SeqOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      temp.push({ type: "Equal", text: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      temp.push({ type: "Insert", text: b[j - 1]! });
      j--;
    } else {
      temp.push({ type: "Delete", text: a[i - 1]! });
      i--;
    }
  }
  return temp.reverse();
}

/**
 * Myers divide and conquer over the region [loA..hiA] x [loB..hiB].
 * Appends ops to `ops` and returns false when the work budget is exhausted
 * before the halves bottom out. Each round of the snake search costs about
 * (n+m) compares, so the budget is spent in units of (n+m) per round; the
 * children share what remains, keeping the total across the whole recursion
 * bounded regardless of how the splits land.
 */
export function myersSplit(
  a: string[],
  b: string[],
  loA: number,
  hiA: number,
  loB: number,
  hiB: number,
  opsBudget: number,
  ops: SeqOp[],
): boolean {
  let n = hiA - loA;
  let m = hiB - loB;

  // Common runs are part of the alignment: emit them and solve the rest.
  let pre = 0;
  while (pre < n && pre < m && a[loA + pre] === b[loB + pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[hiA - 1 - suf] === b[hiB - 1 - suf]) suf++;
  for (let i = 0; i < pre; i++) ops.push({ type: "Equal", text: a[loA + i]! });
  loA += pre;
  loB += pre;
  hiA -= suf;
  hiB -= suf;
  n = hiA - loA;
  m = hiB - loB;

  if (n === 0 || m === 0) {
    if (n === 0) {
      for (let j = 0; j < m; j++) ops.push({ type: "Insert", text: b[loB + j]! });
    } else {
      for (let i = 0; i < n; i++) ops.push({ type: "Delete", text: a[loA + i]! });
    }
    for (let i = 0; i < suf; i++) ops.push({ type: "Equal", text: a[hiA + i]! });
    return true;
  }

  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const half = Math.ceil((n + m) / 2);
  const g = 2 * half;
  // h = furthest forward path per forward diagonal, l = same in reverse.
  const h = new Int32Array(g).fill(-1);
  const l = new Int32Array(g).fill(-1);
  h[half + 1] = 0;
  l[half + 1] = 0;
  // Diagonal ranges narrow once a path runs off the graph.
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  // The middle snake of an SES is always found within (n+m)/2 rounds.
  const rounds = half;
  for (let t = 0; t <= rounds; t++) {
    if (opsBudget < n + m) return false;
    opsBudget -= n + m;
    // Forward: furthest reaching t-path on each diagonal v.
    for (let v = -t + k1start; v <= t - k1end; v += 2) {
      const idx = half + v;
      let x = v === -t || (v !== t && h[idx - 1]! < h[idx + 1]!) ? h[idx + 1]! : h[idx - 1]! + 1;
      let y = x - v;
      while (x < n && y < m && a[loA + x] === b[loB + y]) {
        x++;
        y++;
      }
      h[idx] = x;
      if (x > n) {
        k1end += 2;
      } else if (y > m) {
        k1start += 2;
      } else if (odd) {
        const ridx = half + delta - v;
        if (ridx >= 0 && ridx < g && l[ridx]! !== -1) {
          // Mirror the reverse path's end into forward coordinates.
          if (x >= n - l[ridx]!) {
            return splitAndRecurse(a, b, loA, hiA, loB, hiB, x, y, suf, opsBudget, ops);
          }
        }
      }
    }

    // Reverse: furthest reaching t-path backwards on each diagonal v.
    for (let v = -t + k2start; v <= t - k2end; v += 2) {
      const idx = half + v;
      let x = v === -t || (v !== t && l[idx - 1]! < l[idx + 1]!) ? l[idx + 1]! : l[idx - 1]! + 1;
      let y = x - v;
      while (x < n && y < m && a[hiA - 1 - x] === b[hiB - 1 - y]) {
        x++;
        y++;
      }
      l[idx] = x;
      if (x > n) {
        k2end += 2;
      } else if (y > m) {
        k2start += 2;
      } else if (!odd) {
        const fidx = half + delta - v;
        if (fidx >= 0 && fidx < g && h[fidx]! !== -1) {
          const fx = h[fidx]!;
          const fy = fx - (delta - v);
          if (fx >= n - x) {
            return splitAndRecurse(a, b, loA, hiA, loB, hiB, fx, fy, suf, opsBudget, ops);
          }
        }
      }
    }
  }

  return false;
}

/** Recurse on both sides of the overlap point, then emit the common suffix. */
function splitAndRecurse(
  a: string[],
  b: string[],
  loA: number,
  hiA: number,
  loB: number,
  hiB: number,
  x: number,
  y: number,
  suf: number,
  opsBudget: number,
  ops: SeqOp[],
): boolean {
  const leftOk = myersSplit(a, b, loA, loA + x, loB, loB + y, opsBudget, ops);
  const rightOk = leftOk && myersSplit(a, b, loA + x, hiA, loB + y, hiB, opsBudget, ops);
  if (!rightOk) return false;
  for (let i = 0; i < suf; i++) ops.push({ type: "Equal", text: a[hiA + i]! });
  return true;
}

/**
 * Budget-exhausted corner: compare position by position. Always a valid
 * alignment (every differing pair becomes a Delete plus an Insert, which
 * hunk merging reports as an Update), never fails. A middle that shares
 * nothing at all collapses to one whole-region Update: the region was
 * rewritten, and reporting it line by line would bury that fact.
 */
function zipFallback(a: string[], b: string[], join: string): SeqOp[] {
  const ops: SeqOp[] = [];
  const n = Math.min(a.length, b.length);
  let equals = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) {
      ops.push({ type: "Equal", text: a[i]! });
      equals++;
    } else {
      ops.push({ type: "Delete", text: a[i]! });
      ops.push({ type: "Insert", text: b[i]! });
    }
  }
  for (let i = n; i < a.length; i++) ops.push({ type: "Delete", text: a[i]! });
  for (let i = n; i < b.length; i++) ops.push({ type: "Insert", text: b[i]! });
  if (equals === 0 && a.length > 0 && b.length > 0) {
    return [
      { type: "Delete", text: a.join(join) },
      { type: "Insert", text: b.join(join) },
    ];
  }
  return ops;
}

/**
 * Turn an Insert/Delete/Equal stream into hunks. An adjacent
 * delete+insert pair, in either order, is one substitution: an Update.
 * (The LCS table emits delete-then-insert; the divide and conquer Myers can
 * emit either order depending on where its splits land.)
 */
export function mergeHunks(diffs: SeqOp[]): HunkDiff[] {
  const hunks: HunkDiff[] = [];
  let idx = 0;
  while (idx < diffs.length) {
    const d = diffs[idx]!;
    const next = idx + 1 < diffs.length ? diffs[idx + 1] : undefined;
    if (next && d.type === "Delete" && next.type === "Insert") {
      hunks.push({
        type: "Update",
        text: next.text,
        oldText: d.text,
        newText: next.text,
      });
      idx += 2;
    } else if (next && d.type === "Insert" && next.type === "Delete") {
      hunks.push({
        type: "Update",
        text: d.text,
        oldText: next.text,
        newText: d.text,
      });
      idx += 2;
    } else if (d.type === "Insert") {
      hunks.push({ type: "Insert", text: d.text });
      idx++;
    } else if (d.type === "Delete") {
      hunks.push({ type: "Delete", text: d.text });
      idx++;
    } else {
      idx++;
    }
  }
  return hunks;
}
