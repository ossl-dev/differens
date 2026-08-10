/**
 * The tree the whole engine works on, and the Merkle hashing that makes
 * comparing two subtrees an integer compare.
 */

// 32-bit FNV-1a via Math.imul (single-instruction multiply, no BigInt:
// BigInt arithmetic is 80-90% slower in JS engines). Two independent
// streams are folded into one 53-bit-safe hash: hi * 2^21 + lo.
// Effective entropy is 53 bits, so the birthday bound at 50k nodes is
// ~1e-7 instead of 32-bit's ~30%. Collision means wrongly matching
// different subtrees as identical, which is why we keep the width.
const FNV_PRIME = 0x01000193;
const MIX_PRIME = 0x85ebca6b;
const FNV_SEED_A = 0x811c9dc5;
const FNV_SEED_B = 0x01000193;

function hashFnv(seed: number, byte: number): number {
  return Math.imul(seed ^ byte, FNV_PRIME) >>> 0;
}

function hashStr(seed: number, str: string): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = hashFnv(h, str.charCodeAt(i));
  return h;
}

/**
 * Absorb a full 32-bit word, not a byte. Child hashes are mixed with this:
 * feeding them through hashFnv a byte at a time would only carry 8 bits of
 * the child into the parent, so two different children agreeing on one byte
 * would produce the same parent hash and be matched as identical subtrees.
 */
function mixWord(h: number, word: number, prime: number): number {
  const x = Math.imul(h ^ word, prime) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

/** Fold two 32-bit streams into one 53-bit-safe hash. */
function fold(hA: number, hB: number): number {
  return hA * 0x200000 + (hB & 0x1fffff);
}

/** Split a folded hash back into its two contributing words. */
function foldHi(h: number): number {
  return Math.floor(h / 0x200000);
}
function foldLo(h: number): number {
  return h % 0x200000;
}
export type ByteRange = [start: number, end: number];

export interface Node {
  kind: string;
  label?: string;
  value?: string;
  children: Node[];
  byteRange: ByteRange;
  /** 1-based source line, when the adapter knows it. Lets a reader jump
   *  straight to the change instead of scanning the file for it. */
  line?: number;
  height: number;
  contentHash: number;
  structureHash: number;
}

/** Options for building a Node tree */
export interface BuildNodeOptions {
  kind: string;
  label?: string;
  value?: string;
  children?: Node[];
  byteRange: ByteRange;
  line?: number;
}

export function createNode(opts: BuildNodeOptions): Node {
  const children = opts.children ?? [];
  let maxChildHeight = 0;
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.height > maxChildHeight) maxChildHeight = children[i]!.height;
  }
  const height = maxChildHeight + 1;

  // Merkle hash: contentHash covers kind + label + value + children's contentHash.
  // Two streams: A mixes kind/label/value bytes, B mixes the children's hashes,
  // so a child change flips B while a value change flips A.
  let hA = hashStr(FNV_SEED_A, opts.kind);
  let hB = hashStr(FNV_SEED_B, opts.kind);
  if (opts.label !== undefined) { hA = hashStr(hA, opts.label); hB = hashStr(hB, opts.label); }
  if (opts.value !== undefined) { hA = hashStr(hA, opts.value); hB = hashStr(hB, opts.value); }
  for (let i = 0; i < children.length; i++) {
    const h = children[i]!.contentHash;
    hA = mixWord(hA, foldHi(h), FNV_PRIME);
    hA = mixWord(hA, foldLo(h), MIX_PRIME);
    hB = mixWord(hB, foldLo(h), FNV_PRIME);
    hB = mixWord(hB, foldHi(h), MIX_PRIME);
  }
  const contentHash = fold(hA, hB);

  // structureHash covers kind + children's structureHash, ignores label/value
  let sA = hashStr(FNV_SEED_A, opts.kind);
  let sB = hashStr(FNV_SEED_B, opts.kind);
  for (let i = 0; i < children.length; i++) {
    const h = children[i]!.structureHash;
    sA = mixWord(sA, foldHi(h), FNV_PRIME);
    sA = mixWord(sA, foldLo(h), MIX_PRIME);
    sB = mixWord(sB, foldLo(h), FNV_PRIME);
    sB = mixWord(sB, foldHi(h), MIX_PRIME);
  }
  const structureHash = fold(sA, sB);

  return { kind: opts.kind, label: opts.label, value: opts.value, children,
           byteRange: opts.byteRange, line: opts.line, height, contentHash, structureHash };
}
/**
 * Build a simple tree from a flat key-value object.
 * Used by T4 (config/data tier) for JSON/YAML value trees.
 */
export function treeFromValue(
  value: unknown,
  kind = "root",
): Node {
  if (value === null || value === undefined) {
    return createNode({
      kind,
      value: String(value),
      byteRange: [0, 1],
    });
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return createNode({
      kind: "leaf",
      label: kind,
      value: String(value),
      byteRange: [0, String(value).length],
    });
  }

  if (Array.isArray(value)) {
    const children = value.map((item, i) =>
      treeFromValue(item, `${kind}[${i}]`),
    );
    return createNode({
      kind: "array",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  if (typeof value === "object") {
    const children: Node[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      children.push(treeFromValue(val, key));
    }
    return createNode({
      kind: "object",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  return createNode({
    kind,
    value: String(value),
    byteRange: [0, 1],
  });
}
