import { describe, expect, it } from "bun:test";
import { isBinaryExtension } from "./binary";

describe("isBinaryExtension", () => {
  it("recognizes image, audio, archive, font, and native extensions", () => {
    for (const ext of ["png", "jpg", "gif", "webp", "mp3", "zip", "gz", "wasm", "so", "ttf"]) {
      expect(isBinaryExtension(ext)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isBinaryExtension("PNG")).toBe(true);
    expect(isBinaryExtension("Zip")).toBe(true);
  });

  it("rejects text extensions", () => {
    for (const ext of ["ts", "json", "md", "txt", "html", ""]) {
      expect(isBinaryExtension(ext)).toBe(false);
    }
  });
});
