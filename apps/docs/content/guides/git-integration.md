# Git integration

Register Differens as a Git diff driver to see semantic summaries through
`git diff`. You can also run the CLI directly to compare a whole changeset and
find moves between files.

## Install the driver

From your repository, run:

```bash
differens install-git-driver
```

For the full grammar build, the installer prints the following (with your
repository path):

```text
git diff driver installed.
wrote /private/your/repo/.gitattributes: 24 extensions now use the differens driver.
`git diff` narrates those files instead of printing hunks.
```

The installer records the current executable path in local Git configuration and
writes `diff=differens` rules to `.gitattributes`. By default it registers every
extension listed by `differens languages`. Set `driverExtensions` in
`differens.toml` to choose a subset:

```toml
driverExtensions = ["rs", "ts", "tsx", "py"]
```

Existing attribute rules keep their other attributes. If a rule already names a
different diff driver, Differens appends its own attribute so it takes precedence.
Running the installer again does not duplicate the rules. Reducing the configured
extension list does not remove rules written by an earlier installation; edit
those attributes if you want to stop using the driver for those extensions.

`git diff` and `git diff --staged` now show semantic summaries for matching files.
Other files keep their normal Git output. The driver receives one file pair at a
time, so use the standalone CLI to detect moves across files. After moving or
replacing the installed executable, run the installer again.

To remove the driver:

```bash
git config --local --unset-all diff.differens.command
```

Remove `diff=differens` from the affected `.gitattributes` rules too, keeping any
other attributes on those lines. See the [Git API reference](/reference/git.html)
for the underlying Rust functions.

## Read a Git driver report

For the TypeScript rename and body edit in the
[quickstart](/getting-started/quickstart.html), save the original as the committed
`src/checkout.ts`, make the new edit, then run:

```bash
git diff -- src/checkout.ts
```

```text
  ~ renamed function `computeTotal` to `calculateTotalAmount`
  ~ modified function `computeTotal` (1 removal)
  ~ modified function `calculateTotalAmount` (3 additions)
```

The driver describes this one file pair. For a whole changeset with cross-file
moves, invoke `differens` directly rather than running one driver per file.

## Compare the working tree

With no arguments, `differens` compares the working tree against `HEAD`:

```bash
differens
```

The comparison includes staged and unstaged edits plus untracked files. On a
branch without a commit, existing files appear as additions. File read errors
and failed Git commands produce errors rather than empty comparisons.

Submodule comparisons preserve changes that Git exposes, including dirty,
uninitialized, and unborn submodule states. Differens reports those entries;
it does not recursively analyze each submodule's internal changeset.

## Compare commits

Use a range or two refs:

```bash
differens main..feature
differens HEAD~1 HEAD
```

Both forms compare the selected trees. File summaries appear in order, followed
by any cross-file moves. Modified declaration moves must retain the same name
and pass the similarity threshold. A move combined with a rename or substantial
rewrite can remain an addition and a removal.

For a repository whose latest commit contains that same example, the command
`differens HEAD~1 HEAD` produces:

```text
  ~ renamed function `computeTotal` to `calculateTotalAmount`
  ~ modified function `computeTotal` (1 removal)
  ~ modified function `calculateTotalAmount` (3 additions)

3 modifications
```

## Compare directory snapshots

```bash
differens release/1.0/ release/1.1/
```

Files at matching relative paths are compared. Files on only one side appear as
additions or removals; correlation can pair them into exact or modified file
renames. Walks skip generated and vendor directories, including `.git`,
`node_modules`, `target`, `dist`, `build`, and `vendor`. Large or unsupported
semantic inputs can fall back to lines.

File and directory comparisons work outside a Git repository. Use `./` or absolute
paths when a filename could also resolve as a Git ref, and `--` before filenames
that begin with a dash.

## What the reports tell you

Differens names syntax changes, groups edits under declarations, and detects
supported moves. Use JSON for the original actions, or `--format=llm` for compact
summaries with source locations. A move does not establish that behavior stayed
the same; read the source or a line diff when reviewing behavior.

Formatting-only edits often disappear when the parsed structure stays the same.
Parsing, matching, and output still take time; see [benchmarks](/guides/benchmarks.html)
for measured workloads.

## Choosing a line diff or semantic report

| Question | Useful view |
| --- | --- |
| Which exact text was replaced? | A normal Git line diff |
| Which declaration was renamed or edited? | Differens terminal or Markdown summary |
| Did a supported declaration move between files? | A whole-changeset Differens report |
| Which raw actions and scopes did matching produce? | `--format=json` |
| Which source lines should an agent inspect? | `--format=llm` |

Reformatting can disappear when the parsed structure stays the same, but
semantic comparison still costs parsing and matching. See
[benchmarks](/guides/benchmarks.html) for measured native results.
