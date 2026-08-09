import { describe, expect, it } from "bun:test";
import { classifyFile, Tier } from "./index";

describe("classifyFile", () => {
  it("classifies JSON as Data tier", () => {
    const info = classifyFile("config.json");
    expect(info.tier).toBe(Tier.Data);
  });

  it("classifies TypeScript as Code tier", () => {
    const info = classifyFile("app.ts");
    expect(info.tier).toBe(Tier.Code);
  });

  it("classifies HTML as Markup tier", () => {
    const info = classifyFile("index.html");
    expect(info.tier).toBe(Tier.Markup);
  });

  it("classifies PNG as Binary tier", () => {
    const info = classifyFile("logo.png");
    expect(info.tier).toBe(Tier.Binary);
  });

  it("classifies TXT as Prose tier", () => {
    const info = classifyFile("readme.txt");
    expect(info.tier).toBe(Tier.Prose);
  });

  it("classifies unknown extension as Raw tier", () => {
    const info = classifyFile("data.xyz");
    expect(info.tier).toBe(Tier.Raw);
  });
});
