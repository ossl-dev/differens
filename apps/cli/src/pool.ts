/**
 * Running per-file diffs across CPUs.
 *
 * Processes, not worker threads: the tree-sitter grammars are non
 * context-aware NAPI addons and abort the runtime the moment one is loaded in
 * a second thread of the same process. Separate address spaces are what makes
 * parsing parallel.
 */

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import type { EditAction } from "@ossl-dev/differens-core";
import type { GitDiffInput as FilePair } from "@ossl-dev/differens-git";
import { narrate } from "@ossl-dev/differens-narrate";
import { diffWithTier, isParseable } from "@ossl-dev/differens-tiers";

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
 * Command line that re-invokes this CLI with `flag`.
 *
 * A compiled single-file executable IS the CLI, so it re-execs itself; run as
 * a script, the runtime needs the entry passed along. A compiled bun binary
 * reports its entry under the virtual /$bunfs/ root, which is how the two are
 * told apart.
 *
 * The worker pool spawns this directly. The git diff driver renders it into a
 * shell command string for `git config` instead, which is why the runtime and
 * its arguments come back separated rather than pre-joined.
 */
export function selfInvocation(flag: string): [string, string[]] {
  const entry = process.argv[1] ?? "";
  const compiled = entry.startsWith("/$bunfs/") || entry.includes("~BUN");
  return [process.execPath, compiled ? [flag] : [entry, flag]];
}

/** Run a worker child over `chunk`, resolving with what it wrote to stdout. */
function runChild(chunk: WorkerJob[]): Promise<WorkerReply[]> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = selfInvocation(WORKER_FLAG);
    const child = spawn(cmd, args, {
      // Children share stderr, so let one voice speak for the pool.
      env: { ...process.env, DIFFERENS_QUIET: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (buf: Buffer) => chunks.push(buf));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`diff worker exited ${code}`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as WorkerReply[]);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin!.end(JSON.stringify(chunk));
  });
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
    const poolSize = Math.max(2, Math.min(8, availableParallelism()));
    const chunks: WorkerJob[][] = Array.from({ length: poolSize }, () => []);
    for (let i = 0; i < filePairs.length; i++) {
      chunks[i % poolSize]!.push({ index: i, pair: filePairs[i]! });
    }

    const runs = chunks.map(async (chunk) => {
      if (chunk.length === 0) return;
      for (const reply of await runChild(chunk)) {
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

/**
 * Stream per-file diffs as they finish, always in input order.
 *
 * A long changeset should start printing before the last file is diffed, so
 * the ndjson format reads from this instead of the batch API. Each index gets
 * a promise its chunk runner resolves the moment the reply lands; the
 * generator awaits them in order, so output order is deterministic while
 * completion stays as early as possible.
 */
export async function* diffFilePairsStream(filePairs: FilePair[]): AsyncGenerator<FileDiff> {
  const parseable = filePairs.filter((p) => isParseable(p.oldPath)).length;

  if (parseable < WORKER_THRESHOLD) {
    for (let i = 0; i < filePairs.length; i++) yield diffInline(filePairs[i]!);
    return;
  }

  const poolSize = Math.max(2, Math.min(8, availableParallelism()));
  const chunks: WorkerJob[][] = Array.from({ length: poolSize }, () => []);
  for (let i = 0; i < filePairs.length; i++) {
    chunks[i % poolSize]!.push({ index: i, pair: filePairs[i]! });
  }

  const pending = filePairs.map(() => {
    let resolve!: (r: FileDiff) => void;
    const promise = new Promise<FileDiff>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  });

  const runs = chunks.map(async (chunk) => {
    if (chunk.length === 0) return;
    try {
      for (const reply of await runChild(chunk)) {
        pending[reply.index]!.resolve({
          actions: reply.actions,
          descriptions: reply.descriptions,
          filePath: reply.filePath,
        });
      }
    } catch {
      // A child that dies loses its slice; finish it on the main thread
      // rather than dropping those files from the report.
      console.error("note: a diff worker failed, finishing on the main thread");
      for (const job of chunk) pending[job.index]!.resolve(diffInline(job.pair));
    }
  });
  const settled = Promise.allSettled(runs);

  for (let i = 0; i < filePairs.length; i++) yield await pending[i]!.promise;
  await settled;
}

interface WorkerJob {
  index: number;
  pair: FilePair;
}

type WorkerReply = FileDiff & { index: number };

/** Worker mode: read a slice of jobs from stdin, write the diffs to stdout. */
export async function runWorker(input: AsyncIterable<Buffer> = process.stdin): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  const jobs = JSON.parse(Buffer.concat(chunks).toString()) as WorkerJob[];
  const replies: WorkerReply[] = jobs.map(({ index, pair }) => ({
    index,
    ...diffInline(pair),
  }));
  console.log(JSON.stringify(replies));
}
