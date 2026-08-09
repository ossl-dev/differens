import { describe, expect, it } from "bun:test";
import { diff } from "./index";

describe("diff", () => {
  it("returns empty array for identical inputs (stub)", () => {
    const result = diff("const x = 1;", "const x = 1;");
    expect(result).toEqual([]);
  });

  it("returns empty array for different inputs (stub)", () => {
    const result = diff("const x = 1;", "const y = 2;");
    expect(result).toEqual([]);
  });
});
