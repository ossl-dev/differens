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

const MAX_LINES = 10_000;

export function diffLines(oldText: string, newText: string): HunkDiff[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    // ponytail: cap at 10k lines — beyond this, fall back to whole-file hash
    if (oldText === newText) return [];
    return [{ type: "Update", text: newText, oldText, newText }];
  }

  const diffs = lcsDiff(oldLines, newLines);
  return mergeHunks(diffs);
}

function lcsDiff(a: string[], b: string[]): { type: "Insert" | "Delete" | "Equal"; text: string }[] {
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
      i--; j--;
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

function mergeHunks(
  diffs: { type: "Insert" | "Delete" | "Equal"; text: string }[],
): HunkDiff[] {
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
