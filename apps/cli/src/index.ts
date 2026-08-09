/**
 * Differens CLI
 *
 * Usage:
 *   differens diff                  diff working tree vs HEAD
 *   differens diff a.ts b.ts        diff two files
 *   differens diff old/ new/        diff two directories
 *   differens install-git-driver    register as git diff driver
 */

import { diff } from "@differens/core";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("differens — semantic diffing engine");
    console.log("Usage: differens diff [<old> <new>]");
    process.exit(0);
  }

  const [command, ...rest] = args;

  switch (command) {
    case "diff": {
      if (rest.length === 2) {
        const [oldFile, newFile] = rest as [string, string];
        const oldSrc = await Bun.file(oldFile).text();
        const newSrc = await Bun.file(newFile).text();
        const changes = diff(oldSrc, newSrc);
        for (const change of changes) {
          console.log(change.description);
        }
      } else {
        console.log("git integration — coming in M0");
      }
      break;
    }
    case "install-git-driver": {
      console.log("git driver registration — coming in M0");
      break;
    }
    default: {
      console.error(`unknown command: ${command}`);
      process.exit(1);
    }
  }
}

main().catch(console.error);
