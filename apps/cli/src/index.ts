#!/usr/bin/env node
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

import { createRequire } from "node:module";
import {
  DRIVER_FLAG,
  diffCommitRange,
  diffDirectories,
  diffDriverCommand,
  diffWorkingTree,
  installGitDriver,
  isDirectory,
  isGitRepo,
  readFilePair,
  resolveRef,
  writeGitAttributes,
} from "@ossl-dev/differens-git";
import { formatChanges, narrate } from "@ossl-dev/differens-narrate";
import type { OutputFormat } from "@ossl-dev/differens-narrate";
import { diffWithTier, getExtractors, initExtractors } from "@ossl-dev/differens-tiers";
import { loadConfig } from "./config";
import { WORKER_FLAG, runWorker, selfInvocation } from "./pool";
import { report } from "./report";

/**
 * Read from package.json rather than a literal, so `--version` cannot drift
 * from what was published. `../package.json` resolves the same from source,
 * from dist/ and from an installed node_modules copy.
 */
function version(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig();

  // Internal: this process was spawned by a parent CLI to diff a slice of files.
  if (args[0] === WORKER_FLAG) {
    await runWorker();
    return;
  }

  // Internal: git invoked us as a registered diff driver.
  if (args[0] === DRIVER_FLAG) {
    await handleGitDriver(args.slice(1));
    return;
  }

  if (args.length === 0) {
    // Bare invocation: diff working tree vs HEAD
    await handleDiff([], config.format);
    return;
  }

  const [command, ...rest] = args;

  switch (command) {
    case "diff":
      // Explicit alias, same as bare invocation
      await handleDiff(rest, config.format);
      break;
    case "languages":
      await handleLanguages();
      break;
    case "install-git-driver":
      await handleInstallGitDriver(config.driverExtensions);
      break;
    case "--help":
    case "-h":
      printUsage();
      break;
    case "--version":
    case "-v":
      console.log(`differens v${version()}`);
      break;
    default:
      // Anything else is treated as diff inputs:
      // differens a.ts b.ts, differens main..feature, differens <sha1> <sha2>
      await handleDiff(args, config.format);
  }
}

async function handleDiff(args: string[], defaultFormat: OutputFormat = "terminal"): Promise<void> {
  // Strip format flags before dispatch
  const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
  const format = parseFormat(args, defaultFormat);

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
      await report(
        await diffDirectories(oldArg, newArg),
        format,
        `${oldArg} and ${newArg} are identical`,
      );
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
    console.error("usage: differens diff [<old> <new>] [--format=json|markdown|llm|ndjson]");
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

  const result = diffWithTier(pair.oldSource, pair.newSource, pair.oldPath, pair.newPath);

  if (result.fallback) {
    console.error(`note: fell back to ${result.fallback} diff`);
  }

  const changes = narrate(result.changes, { filePath: pair.oldPath });
  console.log(formatChanges(changes, { format }));
}

/**
 * Diff one file on git's behalf.
 *
 * Git calls a diff driver with `path old-file old-hex old-mode new-file
 * new-hex new-mode`, where the two files are temporaries it wrote the blobs
 * to. Those temporaries carry generated names, so the tier has to be picked
 * from `path` -- classifying by the temp name would find no extension and
 * line-diff every file the driver was ever registered for.
 */
async function handleGitDriver(argv: string[]): Promise<void> {
  const [path, oldFile, , , newFile] = argv;
  if (!path || !oldFile || !newFile) {
    console.error(`usage: differens ${DRIVER_FLAG} <path> <old-file> <old-hex> <old-mode> ...`);
    console.error("git supplies these; it is not meant to be run by hand");
    process.exit(1);
  }

  // A side that does not exist is /dev/null, which reads as the empty string
  // and lands on the whole-file add or removal path.
  const pair = await readFilePair(oldFile, newFile);
  const result = diffWithTier(pair.oldSource, pair.newSource, path, path);
  console.log(formatChanges(narrate(result.changes, { filePath: path }), { format: "terminal" }));
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

async function handleInstallGitDriver(configuredExtensions?: string[]): Promise<void> {
  const [runtime, args] = selfInvocation(DRIVER_FLAG);
  await installGitDriver(diffDriverCommand(runtime, args));

  // Every registered grammar extension, unless the config pins a subset.
  // A grammar that cannot load here would only produce line diffs under git,
  // so the list is built from what actually loaded.
  await initExtractors();
  const extensions =
    configuredExtensions ??
    getExtractors()
      .flatMap((e) => e.extensions)
      .sort();

  const attributesPath = await writeGitAttributes(extensions);
  console.log("git diff driver installed.");
  console.log(
    `wrote ${attributesPath}: ${extensions.length} extensions now use the differens driver.`,
  );
  console.log("`git diff` narrates those files instead of printing hunks.");
}

function parseFormat(args: string[], fallback: OutputFormat): OutputFormat {
  for (const arg of args) {
    if (arg.startsWith("--format=")) {
      return arg.slice(9) as OutputFormat;
    }
    if (arg === "--json" || arg === "-j") return "json";
    if (arg === "--markdown" || arg === "--md") return "markdown";
    if (arg === "--llm" || arg === "-l") return "llm";
  }
  return fallback;
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
  --format=json|markdown|llm|ndjson   output format (default: terminal)
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
