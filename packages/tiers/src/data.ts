/**
 * Tier 4 — Config / structured data adapter.
 *
 * Parses JSON, YAML (subset), TOML (subset) into value trees.
 * Uses native JSON.parse for JSON, simple parsers for YAML and TOML.
 * Falls back to T1 on parse failure.
 */

import { treeFromValue } from "@differens/core";
import type { Node } from "@differens/core";

/**
 * Parse a data file (JSON, YAML, TOML) into a Node tree.
 */
export function parseData(source: string): Node {
  const trimmed = source.trim();

  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      return treeFromValue(value);
    } catch {
      // Not valid JSON, try other formats
    }
  }

  // Try YAML (simple subset: key-value pairs, basic nesting)
  if (trimmed.includes(":")) {
    try {
      const value = parseYaml(trimmed);
      return treeFromValue(value);
    } catch {
      // Fall through to TOML
    }
  }

  // Try TOML (simple subset: [sections] and key = value)
  if (trimmed.includes("=") || trimmed.includes("[")) {
    try {
      const value = parseToml(trimmed);
      return treeFromValue(value);
    } catch {
      // Fall through
    }
  }

  // Last resort: treat as raw value
  return treeFromValue(trimmed);
}

/**
 * Parse a subset of YAML into a plain object.
 * Handles: scalars, sequences, mappings, nested mappings via indentation.
 * Does NOT handle: anchors, aliases, tags, multi-line strings, flow style.
 * Pontail: good enough for 90% of config files.
 */
function parseYaml(source: string): unknown {
  const lines = source.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim());
  return parseYamlLines(lines, 0, 0)[0];
}

function parseYamlLines(
  lines: string[],
  startIdx: number,
  baseIndent: number,
): [unknown, number] {
  const result: Record<string, unknown> = {};

  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    const indent = line.search(/\S/);
    if (indent < baseIndent) break; // Back to parent level

    if (indent > baseIndent) {
      // Nested — skip (handled by recursion)
      i++;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    // Sequence item
    if (trimmed.startsWith("- ")) {
      const arr: unknown[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const ind = l.search(/\S/);
        if (ind < baseIndent) break;
        if (!l.trim().startsWith("- ")) { i++; continue; }
        const val = l.trim().slice(2).trim();
        if (val === "") {
          // Nested object under sequence item
          const [nested, nextIdx] = parseYamlLines(lines, i + 1, baseIndent + 2);
          arr.push(nested);
          i = nextIdx;
        } else {
          arr.push(parseYamlValue(val));
          i++;
        }
      }
      return [arr, i];
    }

    // Key-value mapping
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const valStr = trimmed.slice(colonIdx + 1).trim();

    if (valStr === "" || valStr === "|" || valStr === ">") {
      // Nested mapping or block scalar
      const nextLine = i + 1 < lines.length ? lines[i + 1]! : "";
      const childIndent = nextLine.search(/\S/);
      if (childIndent > baseIndent) {
        const [nested, nextIdx] = parseYamlLines(lines, i + 1, baseIndent + 2);
        result[key] = nested;
        i = nextIdx;
        continue;
      }
      // ponytail: block scalar not implemented, treat as null
      result[key] = null;
    } else {
      result[key] = parseYamlValue(valStr);
    }
    i++;
  }

  return [result, i];
}

function parseYamlValue(val: string): unknown {
  // Boolean
  if (val === "true" || val === "yes" || val === "on") return true;
  if (val === "false" || val === "no" || val === "off") return false;
  // Null
  if (val === "null" || val === "~" || val === "") return null;
  // Number
  const num = Number(val);
  if (!isNaN(num) && val.trim() !== "") return num;
  // Quoted string
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/**
 * Parse a subset of TOML into a plain object.
 */
function parseToml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;
  const lines = source.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      const parts = sectionMatch[1]!.split(".");
      currentSection = result;
      for (const part of parts) {
        if (!currentSection[part]) currentSection[part] = {};
        currentSection = currentSection[part] as Record<string, unknown>;
      }
      continue;
    }

    // Key = value
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const valStr = trimmed.slice(eqIdx + 1).trim();
    currentSection[key] = parseTomlValue(valStr);
  }

  return result;
}

function parseTomlValue(val: string): unknown {
  // String
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Boolean
  if (val === "true") return true;
  if (val === "false") return false;
  // Array
  if (val.startsWith("[") && val.endsWith("]")) {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  // Integer
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  // Float
  const num = Number(val);
  if (!isNaN(num)) return num;
  // Bare string
  return val;
}

export { treeFromValue };
