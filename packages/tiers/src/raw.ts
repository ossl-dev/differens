/**
 * Tier 1: Raw fallback. LCS-based line diff.
 * Safety net for every other tier — must be fast and never crash.
 */

export interface HunkDiff {
  type: "Insert" | "Delete" | "Update";
  text: string;
  oldText?: string;
  newText?: string;
}

/** Bounds the LCS table at 2000x2000 Uint16 = 8MB after common lines are trimmed. */
const MAX_LINES = 2_000;

export function diffLines(oldText: string, newText: string): HunkDiff[] {
  if (oldText === newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Identical head and tail are the overwhelming majority of any real edit and
  // contribute nothing to the LCS, so trim them before building the table.
  // Without this, two 10k-line files differing by one line still allocated the
  // full 10k x 10k table: 200MB.
  let head = 0;
  const shortest = Math.min(oldLines.length, newLines.length);
  while (head < shortest && oldLines[head] === newLines[head]) head++;

  let tail = 0;
  while (
    tail < shortest - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);

  // The table is O(n*m); past this the diff is not worth its memory.
  if (oldMiddle.length > MAX_LINES || newMiddle.length > MAX_LINES) {
    return [{ type: "Update", text: newText, oldText, newText }];
  }

  const diffs = lcsDiff(oldMiddle, newMiddle);
  return mergeHunks(diffs);
}

function lcsDiff(
  a: string[],
  b: string[],
): { type: "Insert" | "Delete" | "Equal"; text: string }[] {
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

  // Backtrack using push + reverse instead of unshift (O(n) vs O(n^2))
  const temp: { type: "Insert" | "Delete" | "Equal"; text: string }[] = [];
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

function mergeHunks(diffs: { type: "Insert" | "Delete" | "Equal"; text: string }[]): HunkDiff[] {
  const hunks: HunkDiff[] = [];
  let idx = 0;
  while (idx < diffs.length) {
    const d = diffs[idx]!;
    if (d.type === "Delete" && idx + 1 < diffs.length && diffs[idx + 1]!.type === "Insert") {
      hunks.push({
        type: "Update",
        text: diffs[idx + 1]!.text,
        oldText: d.text,
        newText: diffs[idx + 1]!.text,
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
