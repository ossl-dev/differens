/**
 * Tier 2  --  Prose / plain text adapter.
 *
 * Word-level diff for prose documents where line breaks are
 * often just wrapping, not structure.
 */

export interface WordDiff {
  type: "Insert" | "Delete" | "Equal";
  text: string;
}

export interface WordHunk {
  type: "Insert" | "Delete" | "Update";
  text: string;
  oldText?: string;
  newText?: string;
}

const WORD_RE = /\S+|\s+/g;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (let match = WORD_RE.exec(text); match !== null; match = WORD_RE.exec(text)) {
    tokens.push(match[0]);
  }
  return tokens;
}

/**
 * Word-level diff between two prose texts.
 * Tokenizes into words+whitespace, then runs LCS.
 */
export function diffWords(oldText: string, newText: string): WordHunk[] {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  // Cap token count: word-level LCS is O(n*m) memory. Beyond the cap,
  // fall back to a whole-text replacement hunk. Same ceiling as raw.ts.
  const MAX_TOKENS = 20_000;
  if (oldTokens.length > MAX_TOKENS || newTokens.length > MAX_TOKENS) {
    if (oldText === newText) return [];
    return [{ type: "Update", text: newText, oldText, newText }];
  }

  // LCS
  const n = oldTokens.length;
  const m = newTokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diffs
  const rawDiffs: WordDiff[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      rawDiffs.unshift({ type: "Equal", text: oldTokens[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rawDiffs.unshift({ type: "Insert", text: newTokens[j - 1]! });
      j--;
    } else if (i > 0) {
      rawDiffs.unshift({ type: "Delete", text: oldTokens[i - 1]! });
      i--;
    }
  }

  // Merge adjacent insert/delete pairs into updates
  const hunks: WordHunk[] = [];
  let idx = 0;
  while (idx < rawDiffs.length) {
    const d = rawDiffs[idx]!;
    if (d.type === "Delete" && idx + 1 < rawDiffs.length && rawDiffs[idx + 1]!.type === "Insert") {
      hunks.push({
        type: "Update",
        text: rawDiffs[idx + 1]!.text,
        oldText: d.text,
        newText: rawDiffs[idx + 1]!.text,
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
