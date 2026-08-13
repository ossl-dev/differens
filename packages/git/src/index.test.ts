import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIVER_FLAG,
  diffCommitRange,
  diffDirectories,
  diffDriverCommand,
  diffWorkingTree,
  generateGitAttributes,
  getChangedFiles,
  getHeadContent,
  getWorkingTreeContent,
  installGitDriver,
  isDirectory,
  isGitRepo,
  readFilePair,
  resolveRef,
} from "./index";

let repoDir: string;
let originalCwd: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

function write(path: string, content: string): void {
  writeFileSync(join(repoDir, path), content);
}

/** Init a repo with an initial commit of the given files. */
function initRepo(files: Record<string, string> = {}): void {
  repoDir = mkdtempSync(join(tmpdir(), "differens-git-"));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(repoDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  git(["add", "."]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
}

beforeEach(() => {
  originalCwd = process.cwd();
  initRepo();
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

describe("generateGitAttributes", () => {
  it("generates gitattributes entries", () => {
    const result = generateGitAttributes(["ts", "tsx", "js"]);
    expect(result).toContain("*.ts diff=differens");
    expect(result).toContain("*.tsx diff=differens");
    expect(result).toContain("*.js diff=differens");
  });

  it("handles empty extension list", () => {
    expect(generateGitAttributes([])).toBe("");
  });
});

describe("diffDriverCommand", () => {
  it("leaves an ordinary path alone", () => {
    expect(
      diffDriverCommand("/usr/local/bin/node", ["/opt/differens.js", "--git-diff-driver"]),
    ).toBe("/usr/local/bin/node /opt/differens.js --git-diff-driver");
  });

  it("quotes a runtime living under a path with a space", () => {
    expect(diffDriverCommand("/Applications/My Tools/node", ["--git-diff-driver"])).toBe(
      "'/Applications/My Tools/node' --git-diff-driver",
    );
  });

  it("survives a single quote in the path", () => {
    expect(diffDriverCommand("/home/o'brien/node", [])).toBe("'/home/o'\\''brien/node'");
  });
});

describe("repo detection", () => {
  it("is inside a repo after init, outside one elsewhere", async () => {
    expect(await isGitRepo()).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), "differens-none-"));
    process.chdir(outside);
    expect(await isGitRepo()).toBe(false);
    rmSync(outside, { recursive: true, force: true });
    process.chdir(repoDir);
  });

  it("returns an empty file list outside a repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "differens-none-"));
    process.chdir(outside);
    expect(await getChangedFiles()).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
    process.chdir(repoDir);
  });

  it("resolves refs and rejects garbage", async () => {
    expect(await resolveRef("HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRef("no-such-ref")).toBeNull();
  });
});

describe("working tree diff", () => {
  beforeEach(() => {
    initRepo({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
    process.chdir(repoDir);
  });

  it("lists changed files", async () => {
    expect(await getChangedFiles()).toEqual([]);
    write("a.ts", "export const a = 2;\n");
    write("c.ts", "export const c = 3;\n");
    expect((await getChangedFiles()).sort()).toEqual(["a.ts", "c.ts"]);
  });

  it("reads HEAD content and the working tree", async () => {
    expect(await getHeadContent("a.ts")).toBe("export const a = 1;\n");
    expect(await getHeadContent("missing.ts")).toBe("");
    expect(await getWorkingTreeContent("a.ts")).toBe("export const a = 1;\n");
    expect(await getWorkingTreeContent("missing.ts")).toBe("");
  });

  it("pairs old and new sources for changed and added files", async () => {
    write("a.ts", "export const a = 2;\n");
    write("c.ts", "export const c = 3;\n");
    const pairs = await diffWorkingTree();
    expect(pairs).toHaveLength(2);
    const byPath = new Map(pairs.map((p) => [p.oldPath, p]));
    expect(byPath.get("a.ts")!.oldSource).toBe("export const a = 1;\n");
    expect(byPath.get("a.ts")!.newSource).toBe("export const a = 2;\n");
    expect(byPath.get("c.ts")!.oldSource).toBe("");
    expect(byPath.get("c.ts")!.newSource).toBe("export const c = 3;\n");
  });

  it("reads files larger than the old 2 MiB cap in full", async () => {
    const big = `line ${"x".repeat(2 * 1024 * 1024)}\n`;
    write("big.ts", big);
    const pairs = await diffWorkingTree();
    const pair = pairs.find((p) => p.oldPath === "big.ts")!;
    expect(pair.newSource.length).toBeGreaterThan(2 * 1024 * 1024);
  });
});

describe("commit range diff", () => {
  beforeEach(() => {
    initRepo({ "a.ts": "export const a = 1;\n" });
    process.chdir(repoDir);
    write("a.ts", "export const a = 2;\n");
    git(["commit", "-qam", "second"]);
  });

  it("diffs the two commits", async () => {
    const pairs = await diffCommitRange("HEAD~1..HEAD");
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.oldSource).toBe("export const a = 1;\n");
    expect(pairs[0]!.newSource).toBe("export const a = 2;\n");
  });

  it("returns an empty list for an empty range", async () => {
    expect(await diffCommitRange("HEAD..HEAD")).toEqual([]);
  });

  it("rejects a malformed range", async () => {
    expect(diffCommitRange("not-a-range")).rejects.toThrow("invalid range");
  });

  it("rejects unresolvable refs", async () => {
    expect(diffCommitRange("nope..nada")).rejects.toThrow();
  });
});

describe("directory diff", () => {
  it("pairs files across two directory trees", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "differens-old-"));
    const newDir = mkdtempSync(join(tmpdir(), "differens-new-"));
    writeFileSync(join(oldDir, "a.ts"), "const a = 1;\n");
    mkdirSync(join(oldDir, "sub"), { recursive: true });
    writeFileSync(join(oldDir, "sub", "b.ts"), "const b = 1;\n");
    writeFileSync(join(newDir, "a.ts"), "const a = 2;\n");
    mkdirSync(join(newDir, "sub"), { recursive: true });
    writeFileSync(join(newDir, "sub", "c.ts"), "const c = 1;\n");
    mkdirSync(join(newDir, "sub", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(newDir, "sub", "node_modules", "pkg", "x.ts"), "skip me\n");

    const pairs = await diffDirectories(oldDir, newDir);
    const byPath = new Map(pairs.map((p) => [p.oldPath, p]));
    expect(byPath.has("a.ts")).toBe(true);
    expect(byPath.get("a.ts")!.oldSource).toBe("const a = 1;\n");
    expect(byPath.get("a.ts")!.newSource).toBe("const a = 2;\n");
    expect(byPath.has("sub/b.ts")).toBe(true);
    expect(byPath.get("sub/b.ts")!.newSource).toBe("");
    expect(byPath.has("sub/c.ts")).toBe(true);
    expect(byPath.get("sub/c.ts")!.oldSource).toBe("");
    // SKIP_DIRS holds node_modules and everything under it.
    expect(byPath.has("sub/node_modules/pkg/x.ts")).toBe(false);

    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it("reports a whole-file pair for a missing side", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "differens-old-"));
    const newDir = mkdtempSync(join(tmpdir(), "differens-new-"));
    writeFileSync(join(oldDir, "gone.ts"), "const g = 1;\n");
    const pairs = await diffDirectories(oldDir, newDir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.oldSource).toBe("const g = 1;\n");
    expect(pairs[0]!.newSource).toBe("");
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });
});

describe("readFilePair", () => {
  it("reads two files into one pair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "differens-pair-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "old\n");
    writeFileSync(b, "new\n");
    const pair = await readFilePair(a, b);
    expect(pair.oldSource).toBe("old\n");
    expect(pair.newSource).toBe("new\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unreadable old file", async () => {
    expect(readFilePair("/nonexistent/old.ts", "/nonexistent/new.ts")).rejects.toThrow(
      "cannot read file",
    );
  });

  it("rejects an unreadable new file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "differens-pair-"));
    const a = join(dir, "a.ts");
    writeFileSync(a, "old\n");
    expect(readFilePair(a, join(dir, "missing.ts"))).rejects.toThrow("cannot read file");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isDirectory", () => {
  it("tells files from directories", async () => {
    write("f.txt", "x");
    expect(await isDirectory("f.txt")).toBe(false);
    expect(await isDirectory(repoDir)).toBe(true);
    expect(await isDirectory("missing")).toBe(false);
  });
});

describe("installGitDriver", () => {
  it("registers the driver command and clears stale textconv config", async () => {
    git(["config", "diff.differens.textconv", "old-converter"]);
    git(["config", "diff.differens.cachetextconv", "true"]);
    await installGitDriver("bun run cli --git-diff-driver");

    const config = git(["config", "--list", "--local"]);
    expect(config).toContain("diff.differens.command=bun run cli --git-diff-driver");
    expect(config).not.toContain("textconv");
    expect(config).not.toContain("cachetextconv");
  });

  it("refuses to run outside a repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "differens-none-"));
    process.chdir(outside);
    expect(installGitDriver("x")).rejects.toThrow("not in a git repository");
    rmSync(outside, { recursive: true, force: true });
    process.chdir(repoDir);
  });
});

describe("DRIVER_FLAG", () => {
  it("is the flag git appends its driver arguments to", () => {
    expect(DRIVER_FLAG).toBe("--git-diff-driver");
  });
});
