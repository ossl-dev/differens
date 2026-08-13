/**
 * Tier 2  --  Prose / plain text adapter.
 *
 * Two levels: documents diff as paragraph trees, so a moved paragraph is a
 * Move; inside a paragraph that survived, words diff as a token sequence.
 * Paragraphs stay leaves during tree matching, which keeps repeated tokens
 * (spaces, common words) out of the top-down hash buckets where they would
 * pair off quadratically.
 */

import { createNode, diffTrees } from "@ossl-dev/differens-core";
import type { EditAction } from "@ossl-dev/differens-core";
import { type HunkDiff, diffSequences, mergeHunks } from "./sequence";

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
 * Word-level diff between two prose texts. Flattened API, kept for callers
 * that only need word hunks; the tier pipeline uses diffProseActions so
 * paragraph moves survive.
 */
export function diffWords(oldText: string, newText: string): WordHunk[] {
  if (oldText === newText) return [];
  return mergeHunks(diffSequences(tokenize(oldText), tokenize(newText), ""));
}

/** Split into paragraphs, trimming the end each time. */
function splitParagraphs(text: string): string[] {
  // Trim paragraph ends: the final newline belongs to the document, not to
  // the last paragraph, and counting it there made an identical paragraph
  // moved to the end hash differently.
  return text.split(/\n\n+/).map((paragraph) => paragraph.replace(/\s+$/, ""));
}

/** One word hunk as a typed edit action inside its paragraph. */
function wordAction(h: WordHunk, position: number): EditAction {
  const context = [{ kind: "paragraph" }];
  if (h.type === "Update") {
    return {
      type: "Update",
      context,
      node: createNode({ kind: "word", value: h.text, byteRange: [0, h.text.length] }),
      detail: { kind: "ValueChanged", from: h.oldText ?? "", to: h.newText ?? "" },
    };
  }
  if (h.type === "Insert") {
    return {
      type: "Insert",
      context,
      node: createNode({ kind: "word", value: h.text, byteRange: [0, h.text.length] }),
      parent: createNode({ kind: "paragraph", byteRange: [0, 0] }),
      position,
    };
  }
  return {
    type: "Delete",
    context,
    node: createNode({ kind: "word", value: h.text, byteRange: [0, h.text.length] }),
  };
}

/**
 * Diff two prose texts into edit actions: paragraph-level moves, inserts and
 * deletes come from tree matching; edits inside a paired paragraph come from
 * a word-sequence diff.
 */
export function diffProseActions(oldText: string, newText: string): EditAction[] {
  const paragraphNode = (text: string) =>
    createNode({ kind: "paragraph", value: text, byteRange: [0, text.length] });
  const oldTree = createNode({
    kind: "document",
    children: splitParagraphs(oldText).map(paragraphNode),
    byteRange: [0, oldText.length],
  });
  const newTree = createNode({
    kind: "document",
    children: splitParagraphs(newText).map(paragraphNode),
    byteRange: [0, newText.length],
  });

  const { changes } = diffTrees(oldTree, newTree);
  const actions: EditAction[] = [];
  for (const change of changes) {
    if (
      change.type === "Update" &&
      change.node.kind === "paragraph" &&
      change.detail.kind === "ValueChanged"
    ) {
      // A paragraph that survived with edits: report the words, not the
      // whole-paragraph value swap.
      const hunks = mergeHunks(
        diffSequences(tokenize(change.detail.from ?? ""), tokenize(change.detail.to ?? ""), ""),
      );
      actions.push(...hunks.map((h, i) => wordAction(h, i)));
    } else {
      actions.push(change);
    }
  }
  return actions;
}
