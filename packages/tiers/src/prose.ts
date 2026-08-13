/**
 * Tier 2  --  Prose / plain text adapter.
 *
 * Word-level diff for prose documents where line breaks are
 * often just wrapping, not structure.
 */

import { diffSequences, mergeHunks, type HunkDiff } from "./sequence";

export interface WordDiff {
  type: "Insert" | "Delete" | "Equal";
  text: string;
}

export type WordHunk = HunkDiff;

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
 * Tokenizes into words+whitespace, then diffs the token sequences.
 */
export function diffWords(oldText: string, newText: string): WordHunk[] {
  if (oldText === newText) return [];
  return mergeHunks(diffSequences(tokenize(oldText), tokenize(newText), ""));
}
