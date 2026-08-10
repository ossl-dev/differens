import { describe, expect, it } from "bun:test";
import { diffDriverCommand, generateGitAttributes } from "./index";

describe("generateGitAttributes", () => {
  it("generates gitattributes entries", () => {
    const result = generateGitAttributes(["ts", "tsx", "js"]);
    expect(result).toContain("*.ts diff=differens");
    expect(result).toContain("*.tsx diff=differens");
    expect(result).toContain("*.js diff=differens");
  });

  it("handles empty extension list", () => {
    const result = generateGitAttributes([]);
    expect(result).toBe("");
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
    // git hands the command to a shell, so an unescaped quote would end the
    // string early and run the rest as separate words.
    expect(diffDriverCommand("/home/o'brien/node", [])).toBe("'/home/o'\\''brien/node'");
  });
});
