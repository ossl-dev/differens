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

import { diffWithTier, getExtractors, initExtractors } from "@differens/tiers";
import { narrate, formatChanges } from "@differens/narrate";
import type { OutputFormat } from "@differens/narrate";
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
import { runWorker, WORKER_FLAG } from "./pool";
import { report } from "./report";

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

async function handleInstallGitDriver(): Promise<void> {
  await installGitDriver();
  console.log("git diff driver installed.");
  console.log("add to .gitattributes:");
  console.log("  *.ts diff=differens");
  console.log("  *.tsx diff=differens");
  console.log("  *.js diff=differens");
  console.log("  ...");
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

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

