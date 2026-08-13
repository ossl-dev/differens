import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

let dir: string;

function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [ENTRY, ...args], {
      cwd: opts.cwd ?? dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function write(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(message = "commit"): void {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "differens-e2e-"));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CLI: working tree", () => {
  it("prints nothing changed on a clean tree", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    const { stdout, status } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain("nothing changed");
  });

  it("reports a modified file", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    write("a.ts", "export const a = 2;\n");
    const { stdout, status } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain("changed");
    expect(stdout).toContain("1 modification");
  });

  it("reports an untracked new file", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    write("b.ts", "export const b = 2;\n");
    const { stdout } = runCli([]);
    expect(stdout).toContain("added");
    expect(stdout).toContain("b.ts");
  });

  it("reports a deleted tracked file", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    rmSync(join(dir, "a.ts"));
    const { stdout } = runCli([]);
    expect(stdout).toContain("removed");
    expect(stdout).toContain("a.ts");
  });
});

describe("CLI: file pairs and directories", () => {
  it("detects a rename between two files", () => {
    write("old.ts", "export function parseConfig(raw: string) { return raw; }\n");
    write("new.ts", "export function loadConfig(raw: string) { return raw; }\n");
    const { stdout, status } = runCli(["old.ts", "new.ts"]);
    expect(status).toBe(0);
    expect(stdout).toContain("renamed");
    expect(stdout).toContain("loadConfig");
  });

  it("diffs two directories", () => {
    const other = mkdtempSync(join(tmpdir(), "differens-e2e-other-"));
    write("a.ts", "const a = 1;\n");
    writeFileSync(join(other, "a.ts"), "const a = 2;\n");
    const { stdout, status } = runCli([dir, other]);
    expect(status).toBe(0);
    expect(stdout).toContain("changed");
    rmSync(other, { recursive: true, force: true });
  });

  it("exits 1 with a message for an unreadable file", () => {
    const { status, stderr } = runCli(["missing-a.ts", "missing-b.ts"]);
    expect(status).toBe(1);
    expect(stderr).toContain("cannot read file");
  });
});

describe("CLI: commit ranges", () => {
  it("diffs two commits", () => {
    write("a.ts", "export const a = 1;\n");
    commit("first");
    write("a.ts", "export const a = 2;\n");
    commit("second");
    const { stdout, status } = runCli(["HEAD~1", "HEAD"]);
    expect(status).toBe(0);
    expect(stdout).toContain("changed");
    expect(stdout).toContain("1 modification");
  });

  it("prints nothing changed in range for an empty range", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    const { stdout } = runCli(["HEAD..HEAD"]);
    expect(stdout).toContain("nothing changed");
  });

  it("exits 1 for a malformed range", () => {
    const { status } = runCli(["not-a-range"]);
    expect(status).toBe(1);
  });

  it("detects a cross-file move between commits", () => {
    write(
      "utils.ts",
      "function validate(input: string): boolean { return !!input; }\nexport const keep = 1;\n",
    );
    write("validators.ts", "export const v = 1;\n");
    commit("first");
    write("utils.ts", "export const keep = 1;\n");
    write(
      "validators.ts",
      "export const v = 1;\nfunction validate(input: string): boolean { return !!input; }\n",
    );
    commit("second");
    const { stdout } = runCli(["HEAD~1", "HEAD"]);
    expect(stdout).toContain("cross-file moves");
    expect(stdout).toContain("validate");
    expect(stdout).toContain("utils.ts");
    expect(stdout).toContain("validators.ts");
  });
});

describe("CLI: output formats", () => {
  function twoCommits(): void {
    write("a.ts", "export const a = 1;\n");
    commit("first");
    write("a.ts", "export const a = 2;\n");
    commit("second");
  }

  it("emits parseable JSON with perFile and crossFileMoves", () => {
    twoCommits();
    const { stdout } = runCli(["HEAD~1", "HEAD", "--format=json"]);
    const doc = JSON.parse(stdout);
    expect(Array.isArray(doc.perFile)).toBe(true);
    expect(Array.isArray(doc.crossFileMoves)).toBe(true);
    expect(doc.perFile.length).toBeGreaterThan(0);
  });

  it("emits markdown with a file heading", () => {
    twoCommits();
    const { stdout } = runCli(["HEAD~1", "HEAD", "--format=markdown"]);
    expect(stdout).toContain("## a.ts");
  });

  it("emits the compact llm format", () => {
    twoCommits();
    const { stdout } = runCli(["HEAD~1", "HEAD", "--format=llm"]);
    expect(stdout.startsWith("differens/1")).toBe(true);
    expect(stdout).toContain("# a.ts");
  });
});

describe("CLI: misc commands", () => {
  it("lists languages", () => {
    const { stdout, status } = runCli(["languages"]);
    expect(status).toBe(0);
    expect(stdout).toContain("typescript");
    expect(stdout).toContain("python");
  });

  it("prints the version", () => {
    const { stdout, status } = runCli(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^differens v\d+\.\d+\.\d+$/);
  });

  it("prints help", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("differens");
  });
});

describe("CLI: worker pool on large changesets", () => {
  it("diffs 30 files through the process pool", () => {
    for (let i = 0; i < 30; i++)
      write(`src/f${i}.ts`, `export function f${i}(): number { return ${i}; }\n`);
    commit("first");
    for (let i = 0; i < 30; i++)
      write(`src/f${i}.ts`, `export function f${i}(): number { return ${i + 1}; }\n`);
    const { stdout, status } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain("30 modifications");
  });
});

describe("CLI: config file", () => {
  it("uses the default format from differens.toml", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    write("a.ts", "export const a = 2;\n");
    write("differens.toml", 'format = "json"\n');
    const { stdout, status } = runCli([]);
    expect(status).toBe(0);
    expect(stdout.startsWith("{")).toBe(true);
    expect(stdout).toContain('"perFile"');
  });

  it("a --format flag overrides the config file", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    write("a.ts", "export const a = 2;\n");
    write("differens.toml", 'format = "json"\n');
    const { stdout, status } = runCli(["--format=markdown"]);
    expect(status).toBe(0);
    expect(stdout.startsWith("##")).toBe(true);
  });

  it("finds the config from a subdirectory", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    write("a.ts", "export const a = 2;\n");
    write("differens.toml", 'format = "llm"\n');
    mkdirSync(join(dir, "sub"), { recursive: true });
    const { stdout, status } = runCli([], { cwd: join(dir, "sub") });
    expect(status).toBe(0);
    expect(stdout).toContain("# a.ts");
  });
});

describe("CLI: install-git-driver", () => {
  it("registers the driver and writes .gitattributes", () => {
    write("a.ts", "export const a = 1;\n");
    commit();
    const { status } = runCli(["install-git-driver"]);
    expect(status).toBe(0);
    expect(git(["config", "--get", "diff.differens.command"])).toContain("--git-diff-driver");
    const attrs = readFileSync(join(dir, ".gitattributes"), "utf8");
    expect(attrs).toContain("*.ts diff=differens");
    expect(attrs).toContain("*.py diff=differens");
  });

  it("preserves existing .gitattributes lines", () => {
    write(".gitattributes", "*.md linguist-detectable=true\n");
    write("a.ts", "export const a = 1;\n");
    commit();
    const { status } = runCli(["install-git-driver"]);
    expect(status).toBe(0);
    const attrs = readFileSync(join(dir, ".gitattributes"), "utf8");
    expect(attrs).toContain("*.md linguist-detectable=true");
    expect(attrs).toContain("*.ts diff=differens");
  });
});

describe("CLI: ndjson streaming output", () => {
  it("prints one JSON object per changed file", () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    commit();
    write("a.ts", "export const a = 2;\n");
    write("b.ts", "export const b = 2;\n");
    const { stdout, status } = runCli(["--format=ndjson"]);
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    const docs = lines.map((l) => JSON.parse(l));
    expect(docs.map((d) => d.filePath).sort()).toEqual(["a.ts", "b.ts"]);
    for (const doc of docs) expect(Array.isArray(doc.changes)).toBe(true);
  });

  it("appends a crossFileMoves trailer when a move spans files", () => {
    write(
      "utils.ts",
      "function validate(input: string): boolean { return !!input; }\nexport const keep = 1;\n",
    );
    write("validators.ts", "export const v = 1;\n");
    commit("first");
    write("utils.ts", "export const keep = 1;\n");
    write(
      "validators.ts",
      "export const v = 1;\nfunction validate(input: string): boolean { return !!input; }\n",
    );
    commit("second");
    const { stdout } = runCli(["HEAD~1", "HEAD", "--format=ndjson"]);
    const lines = stdout.trim().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1]!);
    expect(trailer.crossFileMoves).toBeDefined();
    expect(trailer.crossFileMoves.some((m: { name: string }) => m.name === "validate")).toBe(true);
  });
});

describe("CLI: cross-directory rename detection", () => {
  it("reports a whole-file rename between different directories", () => {
    const other = mkdtempSync(join(tmpdir(), "differens-e2e-ren-"));
    mkdirSync(join(other, "lib"), { recursive: true });
    write("src/helpers.ts", "export function helper(x: number): number { return x * 2; }\n");
    writeFileSync(
      join(other, "lib", "util.ts"),
      "export function helper(x: number): number { return x * 2; }\n",
    );
    const { stdout, status } = runCli([dir, other]);
    expect(status).toBe(0);
    expect(stdout).toContain("renamed file");
    expect(stdout).toContain("src/helpers.ts");
    expect(stdout).toContain("lib/util.ts");
    rmSync(other, { recursive: true, force: true });
  });

  it("reports a rename plus edit across directories", () => {
    const other = mkdtempSync(join(tmpdir(), "differens-e2e-ren2-"));
    mkdirSync(join(other, "lib"), { recursive: true });
    write("src/helpers.ts", "export function helper(x: number): number { return x * 2; }\n");
    writeFileSync(
      join(other, "lib", "util.ts"),
      "export function helper(x: number): number { return x * 3; }\n",
    );
    const { stdout, status } = runCli([dir, other]);
    expect(status).toBe(0);
    expect(stdout).toContain("renamed and edited file");
    rmSync(other, { recursive: true, force: true });
  });
});
