import { describe, expect, it } from "bun:test";
import { generateGitAttributes } from "./index";

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
