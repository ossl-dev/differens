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

import { $ } from "bun";

// ---------- Types ----------

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

// ---------- Git operations ----------

/** Check if we're in a git repository */
export async function isGitRepo(): Promise<boolean> {
  try {
    const result = await $`git rev-parse --git-dir`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Resolve a ref to a commit SHA, or null if it is not a valid git ref */
export async function resolveRef(ref: string): Promise<string | null> {
  try {
    const result = await $`git rev-parse --verify ${ref}`.quiet();
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** Get list of changed files in working tree vs HEAD */
export async function getChangedFiles(): Promise<string[]> {
  try {
    const result = await $`git diff HEAD --name-only`.quiet();
    const stdout = result.stdout.toString();
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Get file content at HEAD (or empty string if new file) */
export async function getHeadContent(filePath: string): Promise<string> {
  try {
    const result = await $`git show HEAD:${filePath}`.quiet();
    return result.stdout.toString();
  } catch {
    return ""; // New file  --  no content in HEAD
  }
}

/** Get working tree file content */
export async function getWorkingTreeContent(filePath: string): Promise<string> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return "";
  }
}

/**
 * Diff the entire working tree against HEAD.
 * Returns per-file (old, new) pairs ready for the tier pipeline.
 */
export async function diffWorkingTree(): Promise<GitDiffInput[]> {
  const changedFiles = await getChangedFiles();
  const results: GitDiffInput[] = [];

  for (const filePath of changedFiles) {
    const [oldSource, newSource] = await Promise.all([
      getHeadContent(filePath),
      getWorkingTreeContent(filePath),
    ]);

    results.push({
      oldPath: filePath,
      newPath: filePath,
      oldSource,
      newSource,
    });
  }

  return results;
}

/**
 * Diff a commit range (e.g., "main..feature").
 * Shells out to git diff-tree to get changed files between two refs.
 */
export async function diffCommitRange(
  range: string,
): Promise<GitDiffInput[]> {
  const parts = range.split("..");
  if (parts.length !== 2) throw new Error(`invalid range: ${range}`);

  const [oldRef, newRef] = parts as [string, string];

  try {
    // Get changed files between the two refs
    const nameResult = await $`git diff --name-only ${oldRef} ${newRef}`.quiet();
    const files = nameResult.stdout.toString().trim().split("\n").filter(Boolean);

    const results: GitDiffInput[] = [];

    for (const filePath of files) {
      const [oldSource, newSource] = await Promise.all([
        $`git show ${oldRef}:${filePath}`.quiet().then((r) => r.stdout.toString()).catch(() => ""),
        $`git show ${newRef}:${filePath}`.quiet().then((r) => r.stdout.toString()).catch(() => ""),
      ]);

      results.push({
        oldPath: filePath,
        newPath: filePath,
        oldSource,
        newSource,
      });
    }

    return results;
  } catch (err) {
    throw new Error(
      `failed to diff range ${range}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------- Diff driver registration ----------

/** Generate .gitattributes entry for the diff driver */
export function generateGitAttributes(extensions: string[]): string {
  return extensions.map((ext) => `*.${ext} diff=differens`).join("\n");
}

/**
 * Install the differens git diff driver.
 * Adds config to the local git repo's .git/config.
 */
export async function installGitDriver(): Promise<void> {
  const inRepo = await isGitRepo();
  if (!inRepo) {
    throw new Error("not in a git repository  --  run this from inside a git repo");
  }

  try {
    await $`git config diff.differens.textconv bun differens diff --textconv`.quiet();
  } catch {
    // Already configured  --  that's fine
  }

  try {
    await $`git config diff.differens.cachetextconv true`.quiet();
  } catch {
    // Already configured
  }
}

// ---------- Non-git mode ----------

/** Read two files for standalone (non-git) diffing */
export async function readFilePair(
  oldPath: string,
  newPath: string,
): Promise<GitDiffInput> {
  let oldSource = "";
  let newSource = "";

  try {
    oldSource = await Bun.file(oldPath).text();
  } catch {
    throw new Error(`cannot read file: ${oldPath}`);
  }

  try {
    newSource = await Bun.file(newPath).text();
  } catch {
    throw new Error(`cannot read file: ${newPath}`);
  }

  return { oldPath, newPath, oldSource, newSource };
}
