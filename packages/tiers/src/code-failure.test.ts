/**
 * Grammar-loading failure paths. Lives in its own file because a failed load
 * caches a null entry for the extension, which would poison the other tests
 * in this process.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLanguage, parseCode, requireGrammar, resetLanguagesForTest } from "./code/index";

beforeEach(() => {
  resetLanguagesForTest();
});

afterEach(() => {
  resetLanguagesForTest();
});

describe("loadLanguage failure paths", () => {
  it("returns null and degrades to line nodes when the grammar cannot load", () => {
    const lang = loadLanguage("ts", () => {
      throw new Error("boom");
    });
    expect(lang).toBeNull();
    // The failure is cached: parseCode degrades to a line-based file node.
    const tree = parseCode("export const x = 1;\n", "ts");
    expect(tree.kind).toBe("file");
    expect(tree.children[0]!.kind).toBe("line");
  });

  it("accepts a custom loader that returns a real grammar", () => {
    const lang = loadLanguage("py", () => requireGrammar("tree-sitter-python"));
    expect(lang).not.toBeNull();
    expect(lang!.name).toBe("python");
  });
});

describe("requireGrammar fallback", () => {
  it("resolves an installed grammar from the module's own root", () => {
    const mod = requireGrammar("tree-sitter-go");
    const grammar = (mod.language ?? mod) as object;
    expect(grammar).toBeDefined();
  });

  it("falls back to the working directory when the own root fails", () => {
    // A compiled executable has no node_modules at its module root; the
    // working directory does. Simulate the compiled side with a fake base,
    // and a cwd that has the grammar installed.
    const fakeRoot = join(mkdtempSync(join(tmpdir(), "differens-gram-")), "bundle.js");
    writeFileSync(fakeRoot, "// compiled stub\n");
    const project = mkdtempSync(join(tmpdir(), "differens-proj-"));
    mkdirSync(join(project, "node_modules", "tree-sitter-go"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(
      join(project, "node_modules", "tree-sitter-go", "package.json"),
      '{"main": "index.js"}\n',
    );
    writeFileSync(
      join(project, "node_modules", "tree-sitter-go", "index.js"),
      "module.exports = { stub: true };\n",
    );
    const prev = process.cwd();
    process.chdir(project);
    try {
      const mod = requireGrammar("tree-sitter-go", fakeRoot);
      expect(mod.stub).toBe(true);
    } finally {
      process.chdir(prev);
      rmSync(project, { recursive: true, force: true });
      rmSync(join(fakeRoot, ".."), { recursive: true, force: true });
    }
  });

  it("throws the original error when both roots fail", () => {
    const fakeRoot = join(mkdtempSync(join(tmpdir(), "differens-gram-")), "bundle.js");
    writeFileSync(fakeRoot, "// compiled stub\n");
    // The cwd fallback must also fail: run from a directory without the
    // grammars installed.
    const bare = mkdtempSync(join(tmpdir(), "differens-bare-"));
    mkdirSync(join(bare, "node_modules"), { recursive: true });
    const prev = process.cwd();
    process.chdir(bare);
    try {
      expect(() => requireGrammar("tree-sitter-definitely-not-real", fakeRoot)).toThrow();
    } finally {
      process.chdir(prev);
      rmSync(bare, { recursive: true, force: true });
      rmSync(join(fakeRoot, ".."), { recursive: true, force: true });
    }
  });
});
