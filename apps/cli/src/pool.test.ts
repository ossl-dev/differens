import { describe, expect, it } from "bun:test";
import { WORKER_FLAG, diffInline, diffWithWorkers, selfInvocation } from "./pool";

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
