import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "differens-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfig(dir)).toEqual({});
  });

  it("reads .differensrc.json", () => {
    writeFileSync(
      join(dir, ".differensrc.json"),
      JSON.stringify({ format: "json", driverExtensions: ["ts", "py"] }),
    );
    expect(loadConfig(dir)).toEqual({ format: "json", driverExtensions: ["ts", "py"] });
  });

  it("prefers differens.toml over .differensrc.json", () => {
    writeFileSync(join(dir, ".differensrc.json"), JSON.stringify({ format: "json" }));
    writeFileSync(join(dir, "differens.toml"), 'format = "markdown"\n');
    expect(loadConfig(dir)).toEqual({ format: "markdown" });
  });

  it("walks up from a subdirectory to the nearest config", () => {
    writeFileSync(join(dir, "differens.toml"), 'format = "llm"\n');
    const deep = join(dir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(loadConfig(deep)).toEqual({ format: "llm" });
  });

  it("parses differens.toml with comments, blanks, and arrays", () => {
    writeFileSync(
      join(dir, "differens.toml"),
      '# comment\nformat = "markdown"\n\ndriverExtensions = ["ts", "go"]\n',
    );
    expect(loadConfig(dir)).toEqual({ format: "markdown", driverExtensions: ["ts", "go"] });
  });

  it("ignores unknown keys and malformed lines", () => {
    writeFileSync(join(dir, "differens.toml"), "ai = true\n  not a valid line\nformat = json\n");
    expect(loadConfig(dir)).toEqual({ format: "json" });
  });

  it("ignores an unparseable config file", () => {
    writeFileSync(join(dir, "differens.toml"), 'format = "unclosed\n');
    expect(loadConfig(dir)).toEqual({});
  });

  it("drops invalid values for known keys", () => {
    writeFileSync(join(dir, "differens.toml"), 'format = "excel"\ndriverExtensions = "ts"\n');
    expect(loadConfig(dir)).toEqual({});
  });
});
