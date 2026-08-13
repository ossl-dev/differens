/**
 * Coverage gate: fail the run when line or function coverage drops below
 * the threshold. Reads the lcov report that `bun test --coverage
 * --coverage-reporter=lcov` writes to coverage/lcov.info.
 *
 * Usage: bun test --coverage --coverage-reporter=lcov && bun scripts/coverage-gate.ts
 * Override: LINES=0.9 FUNCS=0.85 bun scripts/coverage-gate.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const LINES = Number.parseFloat(process.env.LINES ?? "0.95");
const FUNCS = Number.parseFloat(process.env.FUNCS ?? "0.9");

function parseLcov(text: string): {
  lines: { hit: number; found: number };
  funcs: { hit: number; found: number };
} {
  let lh = 0;
  let lf = 0;
  let fnh = 0;
  let fnf = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("LH:")) lh += Number.parseInt(line.slice(3), 10);
    else if (line.startsWith("LF:")) lf += Number.parseInt(line.slice(3), 10);
    else if (line.startsWith("FNH:")) fnh += Number.parseInt(line.slice(4), 10);
    else if (line.startsWith("FNF:")) fnf += Number.parseInt(line.slice(4), 10);
  }
  return { lines: { hit: lh, found: lf }, funcs: { hit: fnh, found: fnf } };
}

const report = parseLcov(readFileSync(join(process.cwd(), "coverage", "lcov.info"), "utf8"));
const linePct = report.lines.found > 0 ? report.lines.hit / report.lines.found : 0;
const funcPct = report.funcs.found > 0 ? report.funcs.hit / report.funcs.found : 0;

console.log(
  `coverage: ${(linePct * 100).toFixed(2)}% lines, ${(funcPct * 100).toFixed(2)}% functions`,
);

const failures: string[] = [];
if (linePct < LINES) failures.push(`lines ${(linePct * 100).toFixed(2)}% below ${LINES * 100}%`);
if (funcPct < FUNCS)
  failures.push(`functions ${(funcPct * 100).toFixed(2)}% below ${FUNCS * 100}%`);
if (failures.length > 0) {
  console.error(`coverage gate failed: ${failures.join(", ")}`);
  process.exit(1);
}
