# @ossl-dev/differens-git

Reads file pairs out of git for [differens](https://github.com/ossl-dev/differens) to diff, and registers differens as a git diff driver.

```bash
npm install @ossl-dev/differens-git
```

Shells out to the `git` binary. No native bindings, nothing to compile.

## Getting pairs to diff

```ts
import { diffWorkingTree, diffCommitRange, diffDirectories } from "@ossl-dev/differens-git";

await diffWorkingTree();                 // working tree vs HEAD
await diffCommitRange("main..feature");  // every file changed in a range
await diffDirectories("old/", "new/");   // two trees on disk, no git needed
```

All three return the same shape, ready to hand to a diff:

```ts
interface GitDiffInput {
  oldPath: string;
  newPath: string;
  oldSource: string;
  newSource: string;
}
```

A file that exists on only one side comes back paired against `""`, which
downstream reports as a whole-file add or removal rather than as a hundred
inserted lines.

Blobs are read through a single `git cat-file --batch` process. A 200-file
changeset used to pay 400 process spawns before any diffing started, which on a
warm cache cost more than the diff. Files over 2MB come back empty: they are
generated bundles and lockfiles, and parsing them into a tree helps nobody.

## The diff driver

```ts
import { installGitDriver, diffDriverCommand, DRIVER_FLAG, generateGitAttributes } from "@ossl-dev/differens-git";

await installGitDriver(diffDriverCommand(process.execPath, [entryPath, DRIVER_FLAG]));
```

That registers `diff.differens.command`. Add the matching `.gitattributes`
lines from `generateGitAttributes(["ts", "tsx", "py"])` and `git diff` narrates
those files instead of printing hunks.

Git invokes a driver with `path old-file old-hex old-mode new-file new-hex
new-mode`, where the two files are temporaries of its own naming. Pick your
parser from `path`, not from the temp name -- the temp name has no extension,
and classifying by it line-diffs every file the driver was registered for.

This is a `command` driver, not a `textconv` one. Textconv converts a single
file to text and lets git line-diff the results, and there is no single-file
rendering of a source file that makes a semantic diff fall out of that.

## Also exported

`isGitRepo()`, `resolveRef(ref)`, `getChangedFiles()`, `getHeadContent(path)`,
`getWorkingTreeContent(path)`, `readFilePair(a, b)`, `isDirectory(path)`,
`MAX_DIFF_BYTES`.

`resolveRef` returns `null` rather than throwing for anything that is not a
ref, which is how `differens a.ts b.ts` and `differens main feature` are told
apart from the same two arguments.

## Related

- [`@ossl-dev/differens-core`](https://www.npmjs.com/package/@ossl-dev/differens-core) -- the matching engine
- [`@ossl-dev/differens-tiers`](https://www.npmjs.com/package/@ossl-dev/differens-tiers) -- parses the sources this returns
- [`differens`](https://www.npmjs.com/package/differens) -- the CLI

MIT. [Source](https://github.com/ossl-dev/differens).
