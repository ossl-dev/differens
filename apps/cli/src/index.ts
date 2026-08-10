#!/usr/bin/env bun
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

import { diffWithTier, getExtractors, initExtractors, isParseable } from "@differens/tiers";
import type { EditAction } from "@differens/core";
import { narrate, formatChanges, summarize } from "@differens/narrate";
import type { OutputFormat } from "@differens/narrate";
import { correlate } from "@differens/correlate";
import type { FileChanges } from "@differens/correlate";
import {
  diffWorkingTree,
  diffCommitRange,
  diffDirectories,
  isDirectory,
  readFilePair,
  isGitRepo,
  resolveRef,
  installGitDriver,
} from "@differens/git";
import type { GitDiffInput as FilePair } from "@differens/git";
import type { SemanticChange } from "@differens/core";

// ---------- CLI ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Internal: this process was spawned by a parent CLI to diff a slice of files.
  if (args[0] === WORKER_FLAG) {
    await runWorker();
    return;
  }

  if (args.length === 0) {
    // Bare invocation: diff working tree vs HEAD
    await handleDiff([]);
    return;
  }

  const [command, ...rest] = args;

  switch (command) {
    case "diff":
      // Explicit alias, same as bare invocation
      await handleDiff(rest);
      break;
    case "languages":
      await handleLanguages();
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
      // Anything else is treated as diff inputs:
      // differens a.ts b.ts, differens main..feature, differens <sha1> <sha2>
      await handleDiff(args);
  }
}

// ---------- Diff handler ----------

async function handleDiff(args: string[]): Promise<void> {
  // Strip format flags before dispatch
  const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
  const format = parseFormat(args) as OutputFormat;

  if (nonFlagArgs.length === 0) {
    // Git mode: diff working tree vs HEAD
    await handleGitDiff(format);
  } else if (nonFlagArgs.length === 1 && nonFlagArgs[0]!.includes("..")) {
    await handleRangeDiff(nonFlagArgs[0]!, format);
  } else if (nonFlagArgs.length === 2) {
    const [oldArg, newArg] = nonFlagArgs as [string, string];

    // Two directories: walk both trees and diff file by file.
    const [oldIsDir, newIsDir] = await Promise.all([isDirectory(oldArg), isDirectory(newArg)]);
    if (oldIsDir && newIsDir) {
      await report(await diffDirectories(oldArg, newArg), format, `${oldArg} and ${newArg} are identical`);
      return;
    }
    if (oldIsDir !== newIsDir) {
      console.error(`cannot diff a directory against a file: ${oldArg} ${newArg}`);
      process.exit(1);
    }

    // git-diff style: two refs resolve to commits, otherwise two files
    if (await isGitRepo()) {
      const [oldSha, newSha] = await Promise.all([resolveRef(oldArg), resolveRef(newArg)]);
      if (oldSha && newSha) {
        await handleRangeDiff(`${oldSha}..${newSha}`, format);
        return;
      }
    }
    await handleFileDiff(oldArg, newArg, format);
  } else {
    console.error("usage: differens diff [<old> <new>] [--format=json|md|llm]");
    process.exit(1);
  }
}

async function handleGitDiff(format: OutputFormat): Promise<void> {
  const inGit = await isGitRepo();
  if (!inGit) {
    console.error("not in a git repository");
    console.error("use: differens diff <old> <new> for standalone mode");
    process.exit(1);
  }

  await report(await diffWorkingTree(), format, "nothing changed");
}

async function handleRangeDiff(range: string, format: OutputFormat): Promise<void> {
  await report(await diffCommitRange(range), format, `nothing changed in range: ${range}`);
}

/**
 * Diff a set of file pairs and print the result.
 *
 * Shared by working-tree, commit-range and directory mode: they only differ
 * in how the pairs are collected, and cross-file move detection is worth
 * having in all three.
 */
async function report(
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
      const kind = move.node.kind.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2");
      const name = move.node.label ? ` \`${move.node.label}\`` : "";
      console.log(`  → ${kind}${name} from ${move.fromFile} to ${move.toFile}`);
    }
  }

  console.log(`\n${summarize(allNarratives)}`);
}

async function handleFileDiff(
  oldPath: string,
  newPath: string,
  format: OutputFormat,
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
  console.log(formatChanges(changes, { format }));
}

// ---------- Languages ----------

async function handleLanguages(): Promise<void> {
  await initExtractors();
  const extractors = getExtractors();
  console.log("supported languages:\n");
  for (const ext of extractors) {
    const level = ext.level === "L6" ? "semantic" : "generic";
    console.log(`  ${ext.language} (${level}, ${ext.level}): ${ext.extensions.join(", ")}`);
  }
  console.log("\nall other text files: raw (L1 line diff)");
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

interface FileDiff {
  actions: EditAction[];
  descriptions: string[];
  filePath: string;
}

/**
 * Starting a child costs a process spawn plus a native grammar load. Below
 * this many files the pool loses to just doing the work here.
 */
const WORKER_THRESHOLD = 24;

/** Report an added file under the path it actually exists at. */
function reportedPath(pair: FilePair): string {
  return pair.oldSource === "" && pair.newSource !== "" ? pair.newPath : pair.oldPath;
}

function diffInline(pair: FilePair): FileDiff {
  const result = diffWithTier(pair.oldSource, pair.newSource, pair.oldPath, pair.newPath);
  const filePath = reportedPath(pair);
  const changes = narrate(result.changes, { filePath });
  return {
    actions: changes.map((c) => c.action),
    descriptions: changes.map((c) => c.description),
    filePath,
  };
}

/**
 * Argv that re-invokes this CLI in worker mode.
 *
 * A compiled single-file executable IS the CLI, so it re-execs itself; from
 * source, bun needs the entry script passed along. `Bun.main` sits under the
 * virtual /$bunfs/ root when compiled, which is how the two are told apart.
 */
function workerArgv(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");
  return compiled
    ? [process.execPath, WORKER_FLAG]
    : [process.execPath, Bun.main, WORKER_FLAG];
}

const WORKER_FLAG = "--diff-worker";

/**
 * Diff file pairs across a pool of CPU child processes.
 *
 * Processes, not worker threads: the tree-sitter grammars are non
 * context-aware NAPI addons and abort the runtime ("NAPI FATAL ERROR:
 * napi_create_object") the moment one is loaded in a second thread of the
 * same process -- even a single worker. A thread pool here only appeared to
 * work while a grammar-loading race was quietly downgrading every worker to a
 * line diff. Separate address spaces are what makes parsing parallel.
 *
 * Files are dealt round-robin so a run of large files spreads across the pool
 * instead of landing in one chunk.
 */
async function diffWithWorkers(filePairs: FilePair[]): Promise<FileDiff[]> {
  const results = new Array<FileDiff | undefined>(filePairs.length);

  // Only parsing is expensive enough to be worth a process pool. A changeset
  // of files that will only ever be line-diffed (no grammar available, plain
  // text, a compiled binary that cannot load native addons) finishes sooner
  // here than it takes to start the children.
  const parseable = filePairs.filter((p) => isParseable(p.oldPath)).length;

  if (parseable >= WORKER_THRESHOLD) {
    const poolSize = Math.max(2, Math.min(8, navigator.hardwareConcurrency ?? 4));
    const chunks: WorkerJob[][] = Array.from({ length: poolSize }, () => []);
    for (let i = 0; i < filePairs.length; i++) {
      chunks[i % poolSize]!.push({ index: i, pair: filePairs[i]! });
    }

    const runs = chunks.map(async (chunk) => {
      if (chunk.length === 0) return;
      const child = Bun.spawn(workerArgv(), {
        stdin: new Blob([JSON.stringify(chunk)]),
        stdout: "pipe",
        stderr: "inherit",
        // Children share stderr, so let one voice speak for the pool.
        env: { ...process.env, DIFFERENS_QUIET: "1" },
      });
      const replies = (await new Response(child.stdout).json()) as WorkerReply[];
      for (const reply of replies) {
        results[reply.index] = {
          actions: reply.actions,
          descriptions: reply.descriptions,
          filePath: reply.filePath,
        };
      }
    });

    // A child that dies leaves its slice empty; the inline pass below covers
    // it rather than dropping those files from the report.
    for (const outcome of await Promise.allSettled(runs)) {
      if (outcome.status === "rejected") {
        console.error("note: a diff worker failed, finishing on the main thread");
      }
    }
  }

  for (let i = 0; i < filePairs.length; i++) {
    results[i] ??= diffInline(filePairs[i]!);
  }
  return results as FileDiff[];
}

interface WorkerJob {
  index: number;
  pair: FilePair;
}

type WorkerReply = FileDiff & { index: number };

/** Worker mode: read a slice of jobs from stdin, write the diffs to stdout. */
async function runWorker(): Promise<void> {
  const jobs = (await Bun.stdin.json()) as WorkerJob[];
  const replies: WorkerReply[] = jobs.map(({ index, pair }) => ({
    index,
    ...diffInline(pair),
  }));
  console.log(JSON.stringify(replies));
}

function parseFormat(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--format=")) {
      return arg.slice(9);
    }
    if (arg === "--json" || arg === "-j") return "json";
    if (arg === "--markdown" || arg === "--md") return "markdown";
    if (arg === "--llm" || arg === "-l") return "llm";
  }
  return "terminal";
}

function printUsage(): void {
  console.log(`differens, a semantic diffing engine

usage:
  differens                            diff working tree vs HEAD
  differens <old> <new>                diff two files, or two commits (git refs)
  differens main..feature              diff commit range
  differens languages                  list supported languages
  differens install-git-driver          register as git difftool

options:
  --format=json|markdown|llm           output format (default: terminal)
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
