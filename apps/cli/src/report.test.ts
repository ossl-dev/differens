import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { GitDiffInput } from "@ossl-dev/differens-git";
import { report } from "./report";

const MOVED_SOURCE = "function validate(input: string): boolean { return !!input; }\n";

function pair(
  oldPath: string,
  newPath: string,
  oldSource: string,
  newSource: string,
): GitDiffInput {
  return { oldPath, newPath, oldSource, newSource };
}

/** A changeset where validate() moves from utils.ts to validators.ts. */
function moveChangeset(): GitDiffInput[] {
  // Both files keep other content, so the change is a function Delete plus a
  // function Insert, which the correlator pairs as a move.
  return [
    pair(
      "utils.ts",
      "utils.ts",
      `${MOVED_SOURCE}export const keep = 1;\n`,
      "export const keep = 1;\n",
    ),
    pair(
      "validators.ts",
      "validators.ts",
      "export const v = 1;\n",
      `export const v = 1;\n${MOVED_SOURCE}`,
    ),
  ];
}

let logs: string[];

beforeEach(() => {
  logs = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  spyOn(console, "log").mockRestore();
});

describe("report", () => {
  it("uses an overview for a large changeset and lets --all expose each file", async () => {
    const inputs = Array.from({ length: 30 }, (_, i) =>
      pair(`billing/file${i}.ts`, `billing/file${i}.ts`, "", `export const value${i} = ${i};`),
    );
    await report(inputs, "terminal", "nope");
    expect(logs.join("\n")).toContain("30 files with logical changes: 30 added");
    expect(logs.join("\n")).not.toContain("value29");
    logs.length = 0;
    await report(inputs, "terminal", "nope", { all: true });
    expect(logs.join("\n")).toContain("added file `billing/file29.ts`");
    expect(logs.join("\n")).not.toContain("Selected changes");
  });

  it("accepts streamed file pairs and reports every batch", async () => {
    async function* inputs() {
      for (let i = 0; i < 50; i++)
        yield pair(`a${i}.ts`, `a${i}.ts`, "const x = 1;", "const x = 2;");
    }
    await report(inputs(), "json", "nope");
    const output = JSON.parse(logs[0]!);
    expect(output.perFile).toHaveLength(50);
    expect(output.perFile[49].filePath).toBe("a49.ts");
  });

  it("does not call a cross-file move unchanged or repeat its add/remove facts", async () => {
    await report(moveChangeset(), "terminal", "nope");
    const output = logs.join("\n");
    expect(output).not.toContain("no logical changes");
    expect(output).not.toContain("added function `validate`");
    expect(output).not.toContain("removed function `validate`");
  });

  it("prints the empty message when there are no pairs", async () => {
    await report([], "terminal", "nothing changed");
    expect(logs).toEqual(["nothing changed"]);
  });

  it("prints a terminal report with a summary line", async () => {
    await report([pair("a.ts", "a.ts", "const x = 1;\n", "const x = 2;\n")], "terminal", "nope");
    expect(logs.some((l) => l.includes("changed"))).toBe(true);
    expect(logs.at(-1)).toContain("1 modification");
  });

  it("counts one modified function rather than every changed literal", async () => {
    const source = (offset: number) =>
      `function values(){ return [${Array.from({ length: 100 }, (_, i) => i + offset).join(",")}]; }`;
    await report([pair("a.ts", "a.ts", source(0), source(100))], "terminal", "nope");
    expect(logs[0]).toContain("function `values`");
    expect(logs[0]!.split("\n")).toHaveLength(1);
    expect(logs.at(-1)).toContain("1 modification");
  });

  it("reports a cross-file move in terminal output", async () => {
    await report(moveChangeset(), "terminal", "nope");
    const joined = logs.join("\n");
    expect(joined).toContain("cross-file moves:");
    expect(joined).toContain("validate");
    expect(joined).toContain("utils.ts");
    expect(joined).toContain("validators.ts");
  });

  it("prints one JSON document with perFile and crossFileMoves", async () => {
    await report(moveChangeset(), "json", "nope");
    const doc = JSON.parse(logs[0]!);
    expect(Array.isArray(doc.perFile)).toBe(true);
    expect(doc.crossFileMoves).toHaveLength(1);
    expect(doc.crossFileMoves[0].fromFile).toBe("utils.ts");
    expect(doc.crossFileMoves[0].toFile).toBe("validators.ts");
  });

  it("appends a cross-file section to llm output", async () => {
    await report(moveChangeset(), "llm", "nope");
    const joined = logs.join("\n");
    expect(joined.startsWith("differens/1")).toBe(true);
    expect(joined).toContain("# cross-file");
    expect(joined).toContain("> validate utils.ts -> validators.ts");
  });

  it("prints markdown plus a prose tail for markdown format", async () => {
    await report([pair("a.ts", "a.ts", "const x = 1;\n", "const x = 2;\n")], "markdown", "nope");
    expect(logs[0]).toContain("## a.ts");
    expect(logs.some((l) => l.includes("modification"))).toBe(true);
  });

  it("calls a whole-file rename a rename, not a move", async () => {
    const source = "export const x = 1;\n";
    const renamed = [pair("old.ts", "old.ts", source, ""), pair("new.ts", "new.ts", "", source)];
    await report(renamed, "terminal", "nope");
    const joined = logs.join("\n");
    expect(joined).toContain("renamed file old.ts to new.ts");
  });
});
