/**
 * Seeded pipeline fuzz: random edits to code and config inputs must never
 * crash the tier pipeline, and the emitted changes must always be
 * well-formed. Deterministic (xorshift), fast, no snapshotting.
 */
import { describe, expect, it } from "bun:test";
import { Tier, diffWithTier } from "./index";

function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const VALID_TYPES = new Set(["Insert", "Delete", "Update", "Move"]);

function assertWellFormed(result: ReturnType<typeof diffWithTier>): void {
  for (const change of result.changes) {
    expect(VALID_TYPES.has(change.type)).toBe(true);
    expect(typeof change.node.kind).toBe("string");
    expect(change.node.kind.length).toBeGreaterThan(0);
  }
}

describe("code pipeline fuzz", () => {
  it("survives random edits to a TypeScript file", () => {
    const rand = xorshift(0xc0ffee);
    const base = `function alpha(): number { return 1; }
function beta(): number { return 2; }
function gamma(): number { return 3; }
export const answer = alpha() + beta() + gamma();
`;
    const lines = base.split("\n");

    for (let t = 0; t < 60; t++) {
      const mutated = [...lines];
      const edits = 1 + Math.floor(rand() * 3);
      for (let e = 0; e < edits; e++) {
        const i = Math.floor(rand() * mutated.length);
        const roll = rand();
        if (roll < 0.4) {
          mutated.splice(i, 1);
        } else if (roll < 0.7) {
          mutated.splice(i, 0, `const injected${t}_${e} = ${t};`);
        } else {
          mutated[i] = `// fuzz edit ${t}_${e}\nfunction fuzz${t}_${e}(): number { return ${t}; }`;
        }
      }
      const result = diffWithTier(base, mutated.join("\n"), "a.ts", "a.ts");
      expect(result.tier).toBe(Tier.Code);
      assertWellFormed(result);
    }
  });
});

describe("data pipeline fuzz", () => {
  it("survives random value and key edits to JSON", () => {
    const rand = xorshift(0xbadf00d);
    const base: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) base[`key${i}`] = i;
    const oldJson = JSON.stringify(base);

    for (let t = 0; t < 60; t++) {
      const mutated = { ...base };
      const edits = 1 + Math.floor(rand() * 5);
      for (let e = 0; e < edits; e++) {
        const key = `key${Math.floor(rand() * 25)}`;
        if (rand() < 0.5) {
          mutated[key] = Math.floor(rand() * 1000);
        } else {
          delete mutated[key];
        }
      }
      const result = diffWithTier(oldJson, JSON.stringify(mutated), "config.json", "config.json");
      expect(result.tier).toBe(Tier.Data);
      assertWellFormed(result);
    }
  });

  it("never crashes on malformed JSON in either position", () => {
    const rand = xorshift(0x51a7e);
    const valid = '{"a": 1, "b": 2}';
    const fragments = ['{"a": 1', "{oops", "[1, 2", "", "}", "a: b"];
    for (let t = 0; t < 60; t++) {
      const old = rand() < 0.5 ? valid : fragments[Math.floor(rand() * fragments.length)]!;
      const next = rand() < 0.5 ? valid : fragments[Math.floor(rand() * fragments.length)]!;
      const result = diffWithTier(old, next, "config.json", "config.json");
      assertWellFormed(result);
    }
  });
});
