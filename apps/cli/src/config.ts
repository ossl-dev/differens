/**
 * Config file support: `.differensrc.json` or `differens.toml`, in the
 * working directory or the nearest ancestor that has one.
 *
 * Deliberately tiny. The config exists to change defaults, not to configure
 * the engine: everything else has a flag or a sensible default already.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutputFormat } from "@ossl-dev/differens-narrate";

const FORMATS: readonly OutputFormat[] = ["terminal", "json", "markdown", "llm", "ndjson"];

export interface DifferensConfig {
  /** Default output format when no --format flag is given */
  format?: OutputFormat;
  /** Extensions `install-git-driver` writes into .gitattributes */
  driverExtensions?: string[];
}

/** Config file names, in priority order. */
const CONFIG_FILES = ["differens.toml", ".differensrc.json"];

/**
 * Load the config for a directory, walking up to the nearest ancestor that
 * has one. An unparseable file is skipped, not fatal: a config mistake
 * should not break diffing, and the default behavior is the documented one.
 */
export function loadConfig(startDir: string = process.cwd()): DifferensConfig {
  let dir = startDir;
  for (;;) {
    for (const name of CONFIG_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      const parsed = name.endsWith(".json") ? parseJsonConfig(raw) : parseTomlConfig(raw);
      if (parsed) return parsed;
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

function parseJsonConfig(raw: string): DifferensConfig | undefined {
  try {
    return validateConfig(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * Parse the two keys this config supports out of a TOML file.
 *
 * A hand-rolled subset, on purpose: differens.toml is bootstrapping config
 * (format and driver extensions), not data, and the full TOML parser lives in
 * the data tier. It reads `key = "value"`, `key = value` and
 * `key = ["a", "b"]` lines, skipping comments and blanks.
 */
function parseTomlConfig(raw: string): DifferensConfig | undefined {
  const obj: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    const value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      obj[key] = value.slice(1, -1);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      obj[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
    } else if (value !== "") {
      obj[key] = value;
    }
  }
  return validateConfig(obj);
}

function validateConfig(obj: Record<string, unknown>): DifferensConfig | undefined {
  const out: DifferensConfig = {};
  if (typeof obj.format === "string" && (FORMATS as readonly string[]).includes(obj.format)) {
    out.format = obj.format as OutputFormat;
  }
  if (
    Array.isArray(obj.driverExtensions) &&
    obj.driverExtensions.every((e) => typeof e === "string")
  ) {
    out.driverExtensions = obj.driverExtensions;
  }
  return out;
}
