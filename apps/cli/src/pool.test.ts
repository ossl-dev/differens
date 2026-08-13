import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import {
  WORKER_FLAG,
  diffFilePairsStream,
  diffInline,
  diffWithWorkers,
  runWorker,
  selfInvocation,
} from "./pool";

// diffWithWorkers re-invokes process.argv[1] as the worker entry. Under the
// test runner that is this file, so when the flag is present this module IS
// the worker: run the protocol and stop before any describe() registers.
if (process.argv.includes(WORKER_FLAG)) {
  await runWorker();
  process.exit(0);
}

const OLD = "export function parseConfig(raw: string) { return JSON.parse(raw); }\n";
const NEW = "export function loadConfig(raw: string) { return JSON.parse(raw); }\n";

describe("diffInline", () => {
  it("diffs one pair and narrates it", () => {
    const result = diffInline({ oldPath: "a.ts", newPath: "a.ts", oldSource: OLD, newSource: NEW });
    expect(result.filePath).toBe("a.ts");
    // Narration dedups the rename and the name-leaf value change into one.
    expect(result.actions).toHaveLength(1);
    expect(result.descriptions.some((d) => d.includes("renamed"))).toBe(true);
  });

  it("reports an added file under its new path", () => {
    const result = diffInline({
      oldPath: "gone.ts",
      newPath: "back.ts",
      oldSource: "",
      newSource: NEW,
    });
    expect(result.filePath).toBe("back.ts");
    expect(result.descriptions.some((d) => d.includes("added"))).toBe(true);
  });

  it("reports a removed file under its old path", () => {
    const result = diffInline({
      oldPath: "gone.ts",
      newPath: "gone.ts",
      oldSource: OLD,
      newSource: "",
    });
    expect(result.filePath).toBe("gone.ts");
    expect(result.descriptions.some((d) => d.includes("removed"))).toBe(true);
  });
});

describe("selfInvocation", () => {
  it("re-invokes the current entry with the worker flag", () => {
    const [runtime, args] = selfInvocation(WORKER_FLAG);
    expect(runtime).toBe(process.execPath);
    expect(args[args.length - 1]).toBe(WORKER_FLAG);
  });
});

describe("diffWithWorkers", () => {
  it("diffs small changesets inline and preserves order", async () => {
    const pairs = Array.from({ length: 5 }, (_, i) => ({
      oldPath: `f${i}.ts`,
      newPath: `f${i}.ts`,
      oldSource: i === 2 ? OLD : `const v${i} = 1;\n`,
      newSource: i === 2 ? NEW : `const v${i} = 2;\n`,
    }));
    const results = await diffWithWorkers(pairs);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.filePath)).toEqual(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts"]);
    expect(results[2]!.descriptions.some((d) => d.includes("renamed"))).toBe(true);
  });
});

describe("diffWithWorkers: process pool", () => {
  it("spawns worker children for a large parseable changeset", async () => {
    // 25+ parseable files crosses WORKER_THRESHOLD, so the parent process
    // spawns children, collects their replies, and preserves order.
    const pairs = Array.from({ length: 25 }, (_, i) => ({
      oldPath: `src/f${i}.ts`,
      newPath: `src/f${i}.ts`,
      oldSource: `export function f${i}(): number { return ${i}; }\n`,
      newSource: `export function f${i}(): number { return ${i + 1}; }\n`,
    }));
    const results = await diffWithWorkers(pairs);
    expect(results).toHaveLength(25);
    expect(results.map((r) => r.filePath)).toEqual(
      Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`),
    );
    expect(results[0]!.descriptions.some((d) => d.includes("changed"))).toBe(true);
  });

  it("falls back to inline diffing for a changeset with no parseable files", async () => {
    const pairs = Array.from({ length: 25 }, (_, i) => ({
      oldPath: `note${i}.txt`,
      newPath: `note${i}.txt`,
      oldSource: `text ${i}\n`,
      newSource: `text ${i} changed\n`,
    }));
    const results = await diffWithWorkers(pairs);
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.descriptions.length === 2)).toBe(true);
    expect(results.every((r) => r.descriptions.every((d) => d.includes("added")))).toBe(true);
  });
});

describe("runWorker", () => {
  it("reads jobs from stdin and writes replies to stdout", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    const jobs = JSON.stringify([
      {
        index: 0,
        pair: {
          oldPath: "a.ts",
          newPath: "a.ts",
          oldSource: "const x = 1;\n",
          newSource: "const x = 2;\n",
        },
      },
    ]);
    try {
      await runWorker(Readable.from([Buffer.from(jobs)]));
    } finally {
      console.log = origLog;
    }

    const replies = JSON.parse(logs[0]!);
    expect(replies).toHaveLength(1);
    expect(replies[0].index).toBe(0);
    expect(replies[0].filePath).toBe("a.ts");
    expect(replies[0].descriptions[0]).toContain("changed");
  });
});

describe("diffFilePairsStream", () => {
  it("yields inline diffs in input order below the worker threshold", async () => {
    const pairs = [
      { oldPath: "a.ts", newPath: "a.ts", oldSource: OLD, newSource: NEW },
      { oldPath: "b.ts", newPath: "b.ts", oldSource: OLD, newSource: NEW },
    ];
    const out: string[] = [];
    for await (const result of diffFilePairsStream(pairs)) out.push(result.filePath);
    expect(out).toEqual(["a.ts", "b.ts"]);
  });

  it("yields worker-pool results in input order", async () => {
    // 25 parseable files crosses the worker threshold; children are spawned
    // via the WORKER_FLAG guard at the top of this file.
    const pairs = Array.from({ length: 25 }, (_, i) => ({
      oldPath: `src/f${i}.ts`,
      newPath: `src/f${i}.ts`,
      oldSource: `export function f${i}(): number { return 1; }\n`,
      newSource: `export function f${i}(): number { return 2; }\n`,
    }));
    const out: string[] = [];
    for await (const result of diffFilePairsStream(pairs)) out.push(result.filePath);
    expect(out).toEqual(pairs.map((p) => p.oldPath));
  });

  it("reports each diff under the same path as the batch API", async () => {
    const pairs = Array.from({ length: 25 }, (_, i) => ({
      oldPath: `src/f${i}.ts`,
      newPath: `src/f${i}.ts`,
      oldSource: `export function f${i}(): number { return 1; }\n`,
      newSource: `export function f${i}(): number { return 2; }\n`,
    }));
    const streamed: Record<string, number> = {};
    for await (const result of diffFilePairsStream(pairs)) {
      streamed[result.filePath] = result.actions.length;
    }
    const batch = await diffWithWorkers(pairs);
    for (const r of batch) expect(streamed[r.filePath]).toBe(r.actions.length);
  });
});
