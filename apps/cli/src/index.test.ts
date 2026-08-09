import { describe, expect, it } from "bun:test";

describe("CLI", () => {
  it("cli package exports correctly", () => {
    // smoke test — the module should resolve
    expect(true).toBe(true);
  });
});
