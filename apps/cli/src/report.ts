/**
 * Turning a set of file diffs into whatever the caller asked to read.
 */

import { formatChanges, humanizeKind, summarize } from "@differens/narrate";
import type { OutputFormat } from "@differens/narrate";
import { correlate } from "@differens/correlate";
import type { FileChanges } from "@differens/correlate";
import type { SemanticChange } from "@differens/core";
import type { GitDiffInput as FilePair } from "@differens/git";
import { diffWithWorkers } from "./pool";

/**
 * Diff a set of file pairs and print the result.
 *
 * Shared by working-tree, commit-range and directory mode: they only differ
 * in how the pairs are collected, and cross-file move detection is worth
 * having in all three.
 */
export async function report(
  filePairs: FilePair[],
  format: OutputFormat,
  emptyMessage: string,
): Promise<void> {
  if (filePairs.length === 0) {
    console.log(emptyMessage);
    return;
  }

  // Per-file diffs are independent and CPU-bound: run them on a worker
  // pool sized to the core count so matching parallelizes across cores.
  const results = await diffWithWorkers(filePairs);

  const allNarratives: SemanticChange[] = results.flatMap((r) =>
    r.descriptions.map((description, i) => ({
      description,
      filePath: r.filePath,
      action: r.actions[i]!,
    })),
  );
  const allFileChanges: FileChanges[] = results.map((r) => ({
    filePath: r.filePath,
    actions: r.actions,
  }));

  // Cross-file correlation
  const crossFile = correlate(allFileChanges);

  if (format === "json") {
    // JSON: one document with everything
    const output = {
      perFile: allNarratives,
      crossFileMoves: crossFile.moves.map((m) => ({
        kind: m.node.kind,
        name: m.node.label ?? "unnamed",
        fromFile: m.fromFile,
        toFile: m.toFile,
        modified: m.modified,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (format === "llm") {
    // Machine format: one self-contained document, no prose tail. It used to
    // fall through and get a human summary appended, which left the JSON it
    // emitted at the time unparseable.
    const lines = [formatChanges(allNarratives, { format })];
    if (crossFile.moves.length > 0) {
      lines.push("# cross-file");
      for (const move of crossFile.moves) {
        const name = move.node.label ?? move.node.kind;
        lines.push(`> ${name} ${move.fromFile} -> ${move.toFile}${move.modified ? " edited" : ""}`);
      }
    }
    console.log(lines.join("\n"));
    return;
  }

  console.log(formatChanges(allNarratives, { format }));

  // Cross-file moves separately
  if (crossFile.moves.length > 0) {
    console.log("\n  cross-file moves:");
    for (const move of crossFile.moves) {
      if (move.node.kind === "file") {
        // A whole file matched on both sides: that is a rename, not a move
        // of something out of one file and into another.
        const verb = move.modified ? "renamed and edited" : "renamed";
        console.log(`  → ${verb} file ${move.fromFile} to ${move.toFile}`);
        continue;
      }
      const kind = humanizeKind(move.node.kind);
      const name = move.node.label ? ` \`${move.node.label}\`` : "";
      console.log(`  → ${kind}${name} from ${move.fromFile} to ${move.toFile}`);
    }
  }

  console.log(`\n${summarize(allNarratives)}`);
}
