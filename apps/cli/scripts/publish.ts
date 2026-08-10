/**
 * Publish the CLI under both of its names.
 *
 * `differens` is the name people type -- `npx differens` should just work --
 * and `@ossl/differens-cli` is its home in the ossl org. Rather than making
 * one an alias package that depends on the other (which puts two claims on the
 * same `differens` bin and couples their version ranges forever), the same
 * built artifact goes out under both names.
 *
 * Each publish is staged into a temp directory, so the repo's own
 * package.json is never rewritten mid-publish. That also lets the staged
 * manifest drop fields the registry has no use for: the `workspace:*`
 * devDependencies point at packages that are bundled into dist and will never
 * exist on npm, and shipping them leaves `npm install` inside an unpacked
 * tarball unable to resolve anything.
 *
 * Usage: bun scripts/publish.ts [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["differens", "@ossl/differens-cli"];

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(cliDir));
const dryRun = process.argv.includes("--dry-run");

const manifest = JSON.parse(await Bun.file(join(cliDir, "package.json")).text()) as Record<
  string,
  unknown
>;

// Build from the workspace, where the sources and the toolchain live.
execFileSync("bun", ["run", "build"], { cwd: cliDir, stdio: "inherit" });

for (const name of NAMES) {
  const stage = mkdtempSync(join(tmpdir(), "differens-publish-"));

  cpSync(join(cliDir, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(repoRoot, "README.md"), join(stage, "README.md"));
  cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));

  // Scripts are workspace-relative and would only fail for a consumer who ran
  // them; devDependencies are the bundled workspace packages.
  const { scripts: _scripts, devDependencies: _dev, ...rest } = manifest;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify({ ...rest, name }, null, 2)}\n`);

  const args = ["publish", ...(dryRun ? ["--dry-run"] : [])];
  console.log(`\n=== ${name}${dryRun ? " (dry run)" : ""} ===`);
  execFileSync("npm", args, { cwd: stage, stdio: "inherit" });
}
