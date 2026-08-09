/**
 * Differens CLI
 *
 * Usage:
 *   differens diff                  diff working tree vs HEAD (git mode)
 *   differens diff <old> <new>      diff two files
 *   differens diff <old>/ <new>/    diff two directories
 *   differens diff <range>          diff commit range (e.g. main..feature)
 *   differens languages             list supported languages
 *   differens install-git-driver    register as git diff driver
 */

import { diffWithTier, getExtractors } from "@differens/tiers";
import { narrate, formatChanges, summarize } from "@differens/narrate";
import { correlate } from "@differens/correlate";
import type { FileChanges } from "@differens/correlate";
import {
  diffWorkingTree,
  diffCommitRange,
  readFilePair,
  isGitRepo,
  installGitDriver,
} from "@differens/git";
import type { SemanticChange } from "@differens/core";

// ---------- CLI ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    return;
  }

  const [command, ...rest] = args;

  switch (command) {
    case "diff":
      await handleDiff(rest);
      break;
    case "languages":
      handleLanguages();
      break;
    case "install-git-driver":
      await handleInstallGitDriver();
      break;
    case "--help":
    case "-h":
      printUsage();
      break;
    case "--version":
    case "-v":
      console.log("differens v0.1.0");
      break;
    default:
      console.error(`unknown command: ${command}`);
      console.error("try: differens diff, differens languages, differens --help");
      process.exit(1);
  }
}

// ---------- Diff handler ----------

async function handleDiff(args: string[]): Promise<void> {
  // Strip format flags before dispatch
  const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
  const format = parseFormat(args);

  if (nonFlagArgs.length === 0) {
    // Git mode: diff working tree vs HEAD
    await handleGitDiff(format);
  } else if (nonFlagArgs.length === 1 && nonFlagArgs[0]!.includes("..")) {
    // Commit range: main..feature
    await handleRangeDiff(args[0]!, format);
  } else if (nonFlagArgs.length === 2) {
    // Two files or two directories
    await handleFileDiff(args[0]!, args[1]!, format);
  } else {
    console.error("usage: differens diff [<old> <new>] [--format=json|md]");
    process.exit(1);
  }
}

async function handleGitDiff(format: string): Promise<void> {
  const inGit = await isGitRepo();
  if (!inGit) {
    console.error("not in a git repository");
    console.error("use: differens diff <old> <new> for standalone mode");
    process.exit(1);
  }

  const filePairs = await diffWorkingTree();

  if (filePairs.length === 0) {
    console.log("nothing changed");
    return;
  }

  const allFileChanges: FileChanges[] = [];
  const allNarratives: SemanticChange[] = [];

  for (const pair of filePairs) {
    const result = diffWithTier(
      pair.oldSource,
      pair.newSource,
      pair.oldPath,
      pair.newPath,
    );

    const changes = narrate(result.changes, { filePath: pair.oldPath });
    allNarratives.push(...changes);
    allFileChanges.push({ filePath: pair.oldPath, actions: result.changes });
  }

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

  // Terminal/markdown: per-file changes
  console.log(formatChanges(allNarratives, { format: format as "terminal" | "json" | "markdown" }));

  // Cross-file moves separately
  if (crossFile.moves.length > 0) {
    console.log("\n  cross-file moves:");
    for (const move of crossFile.moves) {
      const kind = move.node.kind.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2");
      console.log(`  → ${kind} \`${move.node.label ?? "unnamed"}\` from ${move.fromFile} to ${move.toFile}`);
    }
  }

  console.log(`\n${summarize(allNarratives)}`);
}

async function handleRangeDiff(range: string, format: string): Promise<void> {
  const filePairs = await diffCommitRange(range);

  if (filePairs.length === 0) {
    console.log("nothing changed in range:", range);
    return;
  }

  const allNarratives: SemanticChange[] = [];

  for (const pair of filePairs) {
    const result = diffWithTier(
      pair.oldSource,
      pair.newSource,
      pair.oldPath,
      pair.newPath,
    );
    allNarratives.push(...narrate(result.changes, { filePath: pair.oldPath }));
  }

  console.log(formatChanges(allNarratives, { format: format as "terminal" | "json" | "markdown" }));
}

async function handleFileDiff(
  oldPath: string,
  newPath: string,
  format: string,
): Promise<void> {
  const pair = await readFilePair(oldPath, newPath);

  const result = diffWithTier(
    pair.oldSource,
    pair.newSource,
    pair.oldPath,
    pair.newPath,
  );

  if (result.fallback) {
    console.error(`note: fell back to ${result.fallback} diff`);
  }

  const changes = narrate(result.changes, { filePath: pair.oldPath });
  console.log(formatChanges(changes, { format: format as "terminal" | "json" | "markdown" }));
}

// ---------- Languages ----------

function handleLanguages(): void {
  const extractors = getExtractors();
  console.log("supported languages:\n");
  for (const ext of extractors) {
    const level = ext.level === "L6" ? "semantic" : "generic";
    console.log(`  ${ext.language} (${level}, ${ext.level}) — ${ext.extensions.join(", ")}`);
  }
  console.log("\nall other text files: raw (L1 — line diff)");
  console.log("binary files: hash only (L0)");
}

// ---------- Install git driver ----------

async function handleInstallGitDriver(): Promise<void> {
  await installGitDriver();
  console.log("git diff driver installed.");
  console.log("add to .gitattributes:");
  console.log("  *.ts diff=differens");
  console.log("  *.tsx diff=differens");
  console.log("  *.js diff=differens");
  console.log("  ...");
}

// ---------- Helpers ----------

function parseFormat(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--format=")) {
      return arg.slice(9);
    }
    if (arg === "--json" || arg === "-j") return "json";
    if (arg === "--markdown" || arg === "--md") return "markdown";
  }
  return "terminal";
}

function printUsage(): void {
  console.log(`differens — semantic diffing engine

usage:
  differens diff                      diff working tree vs HEAD
  differens diff <old> <new>           diff two files
  differens diff main..feature         diff commit range
  differens languages                  list supported languages
  differens install-git-driver          register as git difftool

options:
  --format=json|markdown               output format (default: terminal)
  --help, -h                           show this help
  --version, -v                        show version number

examples:
  differens diff
  differens diff src/app.ts src/app.new.ts
  differens diff main..my-feature
  differens diff --format=json`);
}

// ---------- Entry ----------

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
