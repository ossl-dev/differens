/**
 * Running per-file diffs across CPUs.
 *
 * Processes, not worker threads: the tree-sitter grammars are non
 * context-aware NAPI addons and abort the runtime the moment one is loaded in
 * a second thread of the same process. Separate address spaces are what makes
 * parsing parallel.
 */

import type { EditAction } from "@differens/core";
import type { GitDiffInput as FilePair } from "@differens/git";
import { narrate } from "@differens/narrate";
import { diffWithTier, isParseable } from "@differens/tiers";

export const WORKER_FLAG = "--diff-worker";

export interface FileDiff {
  actions: EditAction[];
  descriptions: string[];
  filePath: string;
}

const WORKER_THRESHOLD = 24;

/** Report an added file under the path it actually exists at. */
function reportedPath(pair: FilePair): string {
  return pair.oldSource === "" && pair.newSource !== "" ? pair.newPath : pair.oldPath;
}

export function diffInline(pair: FilePair): FileDiff {
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
  return compiled ? [process.execPath, WORKER_FLAG] : [process.execPath, Bun.main, WORKER_FLAG];
}

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
export async function diffWithWorkers(filePairs: FilePair[]): Promise<FileDiff[]> {
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
export async function runWorker(): Promise<void> {
  const jobs = (await Bun.stdin.json()) as WorkerJob[];
  const replies: WorkerReply[] = jobs.map(({ index, pair }) => ({
    index,
    ...diffInline(pair),
  }));
  console.log(JSON.stringify(replies));
}
