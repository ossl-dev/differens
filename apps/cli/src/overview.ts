import type { SemanticChange } from "@ossl-dev/differens-core";
import type { CrossFileMatch } from "@ossl-dev/differens-correlate";
import { readableChanges } from "@ossl-dev/differens-narrate";

type FileSummary = { path: string; status: string; changes: SemanticChange[] };
type Area = { path: string; files: FileSummary[] };
const MAX_AREAS = 12;
const MAX_EXAMPLES = 3;

function totals(files: FileSummary[]): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
  return ["added", "removed", "modified", "renamed"]
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join(", ");
}

/** Split the largest areas first, keeping small siblings together when needed. */
function areas(files: FileSummary[]): Area[] {
  const result: Area[] = [{ path: "", files }];
  const done = new Set<Area>();
  while (result.length < MAX_AREAS) {
    const largest = result
      .filter((area) => !done.has(area) && area.files.length > 8)
      .sort((a, b) => b.files.length - a.files.length)[0];
    if (!largest) break;
    const children = new Map<string, FileSummary[]>();
    for (const file of largest.files) {
      const remaining = file.path.slice(largest.path.length).split("/");
      const path = remaining.length > 1 ? `${largest.path}${remaining[0]}/` : largest.path;
      const group = children.get(path) ?? [];
      group.push(file);
      children.set(path, group);
    }
    if (children.size === 1 && children.has(largest.path)) {
      done.add(largest);
      continue;
    }
    const groups = [...children]
      .map(([path, files]) => ({ path, files }))
      .sort((a, b) => b.files.length - a.files.length);
    const capacity = Math.min(4, MAX_AREAS - result.length + 1);
    if (groups.length > capacity) {
      const rest = groups.splice(capacity - 1);
      const other = { path: `${largest.path}(other)`, files: rest.flatMap((area) => area.files) };
      done.add(other);
      groups.push(other);
    }
    result.splice(result.indexOf(largest), 1, ...groups);
  }
  return result.sort((a, b) => b.files.length - a.files.length || a.path.localeCompare(b.path));
}

function examples(area: Area): string[] {
  const ranked = area.files
    .flatMap((file) =>
      readableChanges(file.changes).map((change) => {
        const declaration =
          /^(?:added|removed|renamed|modified|changed) (?:function|method|class) `/.test(
            change.description,
          );
        const test = /(?:test|spec|fixtures)(?:[./-]|$)/.test(file.path);
        const score =
          (test ? 10 : 0) + (declaration ? 0 : change.action.node.kind === "file" ? 2 : 4);
        return { path: file.path, description: change.description, score };
      }),
    )
    .sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of ranked) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    const description = item.description.replace(/\s+/g, " ");
    result.push(
      `${item.path}: ${description.length > 150 ? `${description.slice(0, 149)}…` : description}`,
    );
    if (result.length === MAX_EXAMPLES) break;
  }
  return result;
}

/** Large reports describe each area with exact file totals and selected facts. */
export function overview(
  changes: SemanticChange[],
  moves: CrossFileMatch[],
  format: "terminal" | "markdown",
): string | undefined {
  const byFile = new Map<string, FileSummary>();
  for (const change of changes) {
    const path = change.filePath ?? "(unknown file)";
    let file = byFile.get(path);
    if (!file) {
      file = { path, status: "modified", changes: [] };
      byFile.set(path, file);
    }
    file.changes.push(change);
    if (change.action.node.kind === "file") {
      if (change.action.type === "Insert") file.status = "added";
      if (change.action.type === "Delete") file.status = "removed";
      if (change.action.type === "Move") file.status = "renamed";
    }
  }
  for (const move of moves) {
    for (const path of [move.fromFile, move.toFile]) {
      if (!byFile.has(path)) byFile.set(path, { path, status: "modified", changes: [] });
    }
    if (move.node.kind === "file") {
      byFile.delete(move.fromFile);
      byFile.get(move.toFile)!.status = "renamed";
    }
  }
  const files = [...byFile.values()];
  const facts = readableChanges(changes);
  if (files.length <= 20 && facts.length <= 100 && moves.length <= 20) return undefined;

  const lines = [`${files.length} files with logical changes: ${totals(files)}.`];
  for (const area of areas(files)) {
    lines.push(
      "",
      `${format === "markdown" ? "### " : ""}${area.path || "(root)"} — ${totals(area.files)}`,
    );
    for (const example of examples(area)) lines.push(`  - ${example}`);
  }
  if (moves.length) {
    lines.push("", `${moves.length} cross-file moves; examples:`);
    const ranked = [...moves].sort((a, b) => {
      const rank = (move: CrossFileMatch) =>
        move.node.kind === "file"
          ? 0
          : ["Function", "Method", "Class"].includes(move.node.kind)
            ? 1
            : 2;
      return rank(a) - rank(b);
    });
    for (const move of ranked.slice(0, MAX_EXAMPLES))
      lines.push(
        `  - ${move.node.label ?? move.node.kind}: ${move.fromFile} → ${move.toFile}${move.modified ? " (also edited)" : ""}`,
      );
  }
  lines.push(
    "",
    "Selected changes shown above. Use --all for every file; --format=ndjson for all underlying actions.",
  );
  return lines.join("\n");
}
