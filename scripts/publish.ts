/**
 * Publish every public package in the workspace.
 *
 * Two things make this more than `npm publish` in a loop.
 *
 * The manifests in the repo point `main` and `exports` at `src/index.ts`, so
 * editing a package is felt by its dependents without a build step. That is
 * the wrong shape for the registry, where consumers want built JS and the
 * declarations beside it, so the staged manifest is rewritten to dist.
 *
 * And `workspace:*` cannot go out as written: it is a protocol the registry
 * has never heard of. Each one is replaced with a caret range on the version
 * being published in this same run, which is what keeps five packages that
 * were built together installable together.
 *
 * Staging into a temp directory is what makes both safe. The repo's own
 * package.json files are never rewritten, so an interrupted publish cannot
 * leave the workspace pointing at dist or carrying half-rewritten ranges.
 *
 * The CLI goes out under two names. `differens` is what people type and what
 * `npx` resolves; `@ossl/differens-cli` is its home in the ossl org. Same
 * artifact under both, rather than an alias package depending on the other,
 * which would put two claims on the same `differens` bin.
 *
 * Anything passed on the command line goes through to `npm publish`, so
 * `--dry-run` works and so does `--otp=123456`.
 *
 * Usage: bun scripts/publish.ts [npm publish flags]
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  dir: string;
  /** Extra names the same artifact also publishes under. */
  alsoAs?: string[];
}

/** Dependency order: a package is published after everything it imports. */
const TARGETS: Target[] = [
  { dir: "packages/core" },
  { dir: "packages/tiers" },
  { dir: "packages/narrate" },
  { dir: "packages/git" },
  { dir: "packages/correlate" },
  { dir: "apps/cli", alsoAs: ["@ossl/differens-cli"] },
];

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmArgs = process.argv.slice(2);
const dryRun = npmArgs.includes("--dry-run");

type Manifest = Record<string, unknown> & {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const read = (dir: string) =>
  JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as Manifest;

/**
 * Is this exact version already on the registry?
 *
 * Seven publishes go out in one run and a version can only be published once,
 * so a run that dies in the middle -- an expired 2FA challenge, a dropped
 * connection -- would otherwise be unresumable: every retry stops on the first
 * package that already succeeded.
 */
function alreadyPublished(name: string, version: string): boolean {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Every workspace package's published version, so `workspace:*` can be
// resolved without asking the registry what exists.
const versions = new Map(TARGETS.map((t) => [read(t.dir).name, read(t.dir).version]));

/**
 * Fail before building if the logged-in account cannot publish these names.
 *
 * Publishing a scoped package you have no rights to returns 404, not 403 --
 * the registry will not confirm that a package it is hiding from you exists.
 * So the natural reading ("my package is missing") is the wrong one, and the
 * real answer, that this npm account is not in the org, is nowhere in the
 * message. Ask up front instead.
 */
function preflight(): void {
  const me = execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim();
  const scopes = new Set(
    TARGETS.flatMap(({ dir, alsoAs }) => [read(dir).name, ...(alsoAs ?? [])])
      .filter((name) => name.startsWith("@"))
      .map((name) => name.slice(1, name.indexOf("/"))),
  );

  for (const scope of scopes) {
    let role = "";
    try {
      role = execFileSync("npm", ["org", "ls", scope, me], { encoding: "utf8" }).trim();
    } catch {
      // Org missing, or invisible to this account -- same outcome either way.
    }
    if (role === "") {
      throw new Error(
        `npm user "${me}" is not a member of the "${scope}" org, so @${scope}/* cannot be published.\n` +
          `Add them (\`npm org set ${scope} ${me} owner\`, run by an owner of the org) or log in as an account that is a member.`,
      );
    }
  }
}

preflight();
execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

for (const { dir, alsoAs } of TARGETS) {
  const manifest = read(dir);
  const isCli = Boolean(manifest.bin);

  for (const name of [manifest.name, ...(alsoAs ?? [])]) {
    if (!dryRun && alreadyPublished(name, manifest.version)) {
      console.log(`\n=== ${name}@${manifest.version} already published, skipping ===`);
      continue;
    }

    const stage = mkdtempSync(join(tmpdir(), "differens-publish-"));
    cpSync(join(repoRoot, dir, "dist"), join(stage, "dist"), { recursive: true });
    cpSync(join(repoRoot, "README.md"), join(stage, "README.md"));
    cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));

    // Workspace-relative and useless to a consumer; devDependencies are the
    // sibling packages, which resolve from the registry once published.
    const { scripts: _scripts, devDependencies: _dev, ...rest } = manifest;

    const dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).map(([dep, range]) => [
        dep,
        range.startsWith("workspace:") ? `^${versions.get(dep) ?? manifest.version}` : range,
      ]),
    );

    const staged: Manifest = {
      ...rest,
      name,
      files: ["dist", "README.md", "LICENSE"],
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    };

    // The CLI is an executable, not an import target; everything else is the
    // reverse. A `bin` path may not start with "./" -- npm strips it during
    // publish and only during publish, so `npm pack` shows a working tarball
    // while the published package ships no command at all.
    if (isCli) {
      staged.bin = { differens: "dist/index.js" };
    } else {
      staged.main = "./dist/index.js";
      staged.types = "./dist/index.d.ts";
      staged.exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };
    }

    writeFileSync(join(stage, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

    if (!isCli && !existsSync(join(stage, "dist", "index.d.ts"))) {
      throw new Error(`${name}: no dist/index.d.ts -- a library with no types is not publishable`);
    }

    console.log(`\n=== ${name}@${manifest.version}${dryRun ? " (dry run)" : ""} ===`);
    execFileSync("npm", ["publish", ...npmArgs], { cwd: stage, stdio: "inherit" });
  }
}
