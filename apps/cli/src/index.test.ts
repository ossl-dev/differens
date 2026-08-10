import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DRIVER_FLAG } from "@ossl/differens-git";

const entry = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

/** Run the CLI the way git runs a registered diff driver. */
function runDriver(path: string, oldSource: string, newSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), "differens-driver-"));
  // Git writes the two blobs to temporaries of its own naming, which is the
  // point of the test: the extension only survives on `path`.
  const oldFile = join(dir, "blob_a");
  const newFile = join(dir, "blob_b");
  writeFileSync(oldFile, oldSource);
  writeFileSync(newFile, newSource);

  return execFileSync(
    process.execPath,
    [
      entry,
      DRIVER_FLAG,
      path,
      oldFile,
      "0".repeat(40),
      "100644",
      newFile,
      "0".repeat(40),
      "100644",
    ],
    { encoding: "utf8" },
  );
}

describe("git diff driver mode", () => {
  it("diffs the two blobs git hands it", () => {
    const out = runDriver(
      "sample.ts",
      "export function parseConfig(raw: string) { return JSON.parse(raw); }\n",
      "export function loadConfig(raw: string) { return JSON.parse(raw); }\n",
    );
    expect(out).toContain("renamed");
    expect(out).toContain("loadConfig");
  });

  it("picks the tier from the display path, not the temp file name", () => {
    // Reformatting only. A line diff would report both lines as changed; the
    // code tier is the only thing that can say nothing happened, so this fails
    // if the temp file's missing extension decides the tier.
    const out = runDriver(
      "sample.ts",
      "export function parse(raw: string) { return JSON.parse(raw); }\n",
      "export function parse( raw: string ) {\n  return JSON.parse(raw);\n}\n",
    );
    expect(out.trim()).toBe("no logical changes");
  });

  it("reports a side git passed as /dev/null as a whole-file change", () => {
    const out = runDriver("added.ts", "", "export const x = 1;\n");
    expect(out).toContain("added");
    expect(out).toContain("added.ts");
  });

  it("exits non-zero when the driver arguments are missing", () => {
    expect(() =>
      execFileSync(process.execPath, [entry, DRIVER_FLAG, "only-a-path"], { stdio: "pipe" }),
    ).toThrow();
  });
});
