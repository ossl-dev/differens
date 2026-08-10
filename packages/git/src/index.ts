/**
 * Git Integration  --  shell out to the git binary.
 *
 * Three levels of integration:
 * 1. GIT_EXTERNAL_DIFF / git difftool (MVP)
 * 2. Registered diff driver via .gitattributes
 * 3. Direct git command for commit range diffing
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Files above this are not worth parsing into a tree: they are generated
 * bundles, lockfiles or vendored blobs, and the tier ladder line-diffs them
 * anyway. Reading them still happens, parsing them does not.
 */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Directories never worth walking when diffing two trees. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
]);

export interface GitDiffInput {
  /** Old file path (working tree or old commit) */
  oldPath: string;
  /** New file path (working tree or new commit) */
  newPath: string;
  /** Old file content */
  oldSource: string;
  /** New file content */
  newSource: string;
}

/**
 * Run git and collect stdout as bytes.
 *
 * Bytes, not a string: `cat-file --batch` frames its records by byte length,
 * so decoding before the framing is parsed would shift every offset the
 * moment a file contains a multi-byte character. Rejects on a non-zero exit,
 * which is how the callers below tell "no such ref" from an empty result.
 */
function git(args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Check if we're in a git repository */
export async function isGitRepo(): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a ref to a commit SHA, or null if it is not a valid git ref */
export async function resolveRef(ref: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--verify", ref])).toString().trim();
  } catch {
    return null;
  }
}

/** Get list of changed files in working tree vs HEAD */
export async function getChangedFiles(): Promise<string[]> {
  try {
    const stdout = (await git(["diff", "HEAD", "--name-only"])).toString();
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Get file content at HEAD (or empty string if new file) */
export async function getHeadContent(filePath: string): Promise<string> {
  try {
    return (await git(["show", `HEAD:${filePath}`])).toString();
  } catch {
    return ""; // New file  --  no content in HEAD
  }
}

/** Get working tree file content */
export async function getWorkingTreeContent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read many blobs in one `git cat-file --batch` process.
 *
 * The previous approach spawned `git show` per file per side: a 200-file
 * changeset paid 400 process spawns before any diffing started, which on a
 * warm cache cost more than the diff itself. One batch process streams them
 * all. Specs that do not exist at that ref come back as empty strings.
 */
async function readBlobs(specs: string[]): Promise<string[]> {
  if (specs.length === 0) return [];

  const out = await git(["cat-file", "--batch"], `${specs.join("\n")}\n`);
  const decoder = new TextDecoder();
  const results: string[] = [];
  let pos = 0;

  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = decoder.decode(out.subarray(pos, nl));
    // "<sha> missing" / "<sha> ambiguous" have no body to skip.
    const parts = header.split(" ");
    const size = parts.length >= 3 ? Number.parseInt(parts[2]!, 10) : Number.NaN;
    if (!Number.isFinite(size)) {
      results.push("");
      pos = nl + 1;
      continue;
    }
    const start = nl + 1;
    results.push(size > MAX_DIFF_BYTES ? "" : decoder.decode(out.subarray(start, start + size)));
    pos = start + size + 1; // trailing newline that git appends per record
  }

  while (results.length < specs.length) results.push("");
  return results;
}

/**
 * Diff the entire working tree against HEAD.
 * Returns per-file (old, new) pairs ready for the tier pipeline.
 */
export async function diffWorkingTree(): Promise<GitDiffInput[]> {
  const changedFiles = await getChangedFiles();
  if (changedFiles.length === 0) return [];

  // One batch process for every HEAD blob, working-tree reads in parallel.
  const [oldSources, newSources] = await Promise.all([
    readBlobs(changedFiles.map((f) => `HEAD:${f}`)),
    mapWithConcurrency(changedFiles, 16, (f) => getWorkingTreeContent(f)),
  ]);

  return changedFiles.map((filePath, i) => ({
    oldPath: filePath,
    newPath: filePath,
    oldSource: oldSources[i] ?? "",
    newSource: newSources[i] ?? "",
  }));
}

/**
 * Diff a commit range (e.g., "main..feature").
 * Shells out to git diff-tree to get changed files between two refs.
 */
export async function diffCommitRange(range: string): Promise<GitDiffInput[]> {
  const parts = range.split("..");
  if (parts.length !== 2) throw new Error(`invalid range: ${range}`);

  const [oldRef, newRef] = parts as [string, string];

  try {
    // -z keeps paths with spaces, quotes or non-ASCII bytes intact; the
    // default output quotes and escapes them, which then fails to resolve.
    const nameResult = await git(["diff", "--name-only", "-z", oldRef, newRef]);
    const files = nameResult.toString().split("\0").filter(Boolean);
    if (files.length === 0) return [];

    const [oldSources, newSources] = await Promise.all([
      readBlobs(files.map((f) => `${oldRef}:${f}`)),
      readBlobs(files.map((f) => `${newRef}:${f}`)),
    ]);

    return files.map((filePath, i) => ({
      oldPath: filePath,
      newPath: filePath,
      oldSource: oldSources[i] ?? "",
      newSource: newSources[i] ?? "",
    }));
  } catch (err) {
    throw new Error(
      `failed to diff range ${range}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Map items through an async fn with a bounded concurrency pool. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Generate .gitattributes entry for the diff driver */
export function generateGitAttributes(extensions: string[]): string {
  return extensions.map((ext) => `*.${ext} diff=differens`).join("\n");
}

/**
 * The flag git appends its seven driver arguments to.
 *
 * `path old-file old-hex old-mode new-file new-hex new-mode`, the same shape
 * GIT_EXTERNAL_DIFF uses.
 */
export const DRIVER_FLAG = "--git-diff-driver";

/** Quote one argument for the shell git runs the driver command through. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a runtime and its arguments into the command string `git config`
 * wants. Git hands this to a shell, so a runtime living under a path with a
 * space in it has to survive the round trip.
 */
export function diffDriverCommand(runtime: string, args: string[]): string {
  return [runtime, ...args].map(shellQuote).join(" ");
}

/**
 * Install the differens git diff driver.
 * Adds config to the local git repo's .git/config.
 *
 * This registers `diff.differens.command`, which git invokes with both sides
 * at once. It used to register a `textconv` instead, pointing at a
 * `--textconv` mode the CLI never implemented: textconv converts one file to
 * text and lets git line-diff the results, which is the opposite of what a
 * semantic diff engine does, and there is no single-file rendering of a source
 * file that would make it work.
 */
export async function installGitDriver(command: string): Promise<void> {
  const inRepo = await isGitRepo();
  if (!inRepo) {
    throw new Error("not in a git repository  --  run this from inside a git repo");
  }

  await git(["config", "diff.differens.command", command]);

  // Clear what older versions wrote. Left in place it is dead config naming a
  // mode that does not exist, and `git config --get-all` would show both.
  for (const key of ["diff.differens.textconv", "diff.differens.cachetextconv"]) {
    try {
      await git(["config", "--unset-all", key]);
    } catch {
      // Not set  --  nothing to clear.
    }
  }
}

/** Is this path a directory? Used to route `differens old/ new/`. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Relative paths of every file under `root`, skipping build and vcs dirs. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = relative(root, full);
    if (rel.split(sep).some((segment) => SKIP_DIRS.has(segment))) continue;
    files.push(rel);
  }
  return files;
}

/**
 * Diff two directory trees. Files present on only one side become a pair
 * against an empty string, which the tier pipeline reports as a whole-file
 * add or removal.
 */
export async function diffDirectories(oldDir: string, newDir: string): Promise<GitDiffInput[]> {
  const [oldFiles, newFiles] = await Promise.all([listFiles(oldDir), listFiles(newDir)]);
  const paths = [...new Set([...oldFiles, ...newFiles])].sort();
  const oldSet = new Set(oldFiles);
  const newSet = new Set(newFiles);

  // Reads are I/O bound and independent; a bounded pool keeps a 10k-file
  // tree from opening 10k descriptors at once.
  // Paths stay relative to the two roots: they are what the reader typed the
  // command about, and the absolute form repeated the same prefix on every line.
  return mapWithConcurrency(paths, 32, async (rel) => ({
    oldPath: rel,
    newPath: rel,
    oldSource: oldSet.has(rel) ? await readCapped(join(oldDir, rel)) : "",
    newSource: newSet.has(rel) ? await readCapped(join(newDir, rel)) : "",
  }));
}

async function readCapped(path: string): Promise<string> {
  try {
    const { size } = await stat(path);
    return size > MAX_DIFF_BYTES ? "" : await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Read two files for standalone (non-git) diffing */
export async function readFilePair(oldPath: string, newPath: string): Promise<GitDiffInput> {
  let oldSource = "";
  let newSource = "";

  try {
    oldSource = await readFile(oldPath, "utf8");
  } catch {
    throw new Error(`cannot read file: ${oldPath}`);
  }

  try {
    newSource = await readFile(newPath, "utf8");
  } catch {
    throw new Error(`cannot read file: ${newPath}`);
  }

  return { oldPath, newPath, oldSource, newSource };
}
