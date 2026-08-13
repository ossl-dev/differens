/**
 * Tier 1: Raw fallback. Line diff.
 * Safety net for every other tier — must be fast and never crash.
 */

import { diffSequences, mergeHunks, type HunkDiff } from "./sequence";

export type { HunkDiff };

export function diffLines(oldText: string, newText: string): HunkDiff[] {
  if (oldText === newText) return [];
  return mergeHunks(diffSequences(oldText.split("\n"), newText.split("\n")));
}
