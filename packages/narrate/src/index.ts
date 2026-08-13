/**
 * Narration Engine  --  edit script to natural language.
 *
 * Converts typed EditActions into human-readable sentences.
 * Template-based, deterministic, and fast.
 *
 * @packageDocumentation
 */

import type { EditAction, SemanticChange, UpdateAction } from "@ossl-dev/differens-core";

/** `call_expression` / `CallExpression` -> `call expression`. */
export function humanizeKind(kind: string): string {
  return kind
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

export interface NarrationOptions {
  filePath?: string;
}

/**
 * Nearest ancestor that has a name, e.g. { kind: "Class", label: "RetryPolicy" }.
 * Lets narration say "removed function X from class Y".
 */
function nearestNamedAncestor(action: EditAction): { kind: string; label: string } | undefined {
  for (const ctx of action.context) {
    if (ctx.label && ctx.label !== "unnamed") {
      return { kind: humanizeKind(ctx.kind), label: ctx.label };
    }
  }
  return undefined;
}

/** One-line, length-capped glimpse of a node's source text. */
function preview(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What to call a node: its name if it has one, else a glimpse of its source.
 * Anonymous nodes used to be narrated as `unnamed`, which told the reader
 * nothing and dominated the output on real files.
 */
function subject(kind: string, node: { label?: string; value?: string }): string {
  const name = node.label ?? preview(node.value, 40);
  return name ? `${kind} \`${name}\`` : kind;
}

/**
 * One EditAction as an English sentence, with its containing scope when it has
 * one: "removed function `parse` from class `Config`".
 */
export function narrateAction(action: EditAction): string {
  const kind = humanizeKind(action.node.kind);
  const what = subject(kind, action.node);
  const scope = nearestNamedAncestor(action);
  const scopePhrase = scope ? ` in ${scope.kind} \`${scope.label}\`` : "";

  switch (action.type) {
    case "Insert":
      return `added ${what}${scopePhrase}`;

    case "Delete":
      return scope ? `removed ${what} from ${scope.kind} \`${scope.label}\`` : `removed ${what}`;

    case "Update":
      if (action.detail.kind === "Renamed") {
        return `renamed ${kind} \`${action.detail.from}\` to \`${action.detail.to}\`${scopePhrase}`;
      }
      if (action.detail.kind === "ValueChanged") {
        const { from, to } = action.detail;
        // A named node keeps its name in the sentence; an anonymous one would
        // otherwise be introduced by the very value the sentence is reporting.
        const target = action.node.label ? `value of ${kind} \`${action.node.label}\`` : kind;
        if (from !== undefined && to !== undefined) {
          return `changed ${target} from \`${preview(from, 40) ?? ""}\` to \`${preview(to, 40) ?? ""}\`${scopePhrase}`;
        }
        if (from !== undefined) return `removed ${target}${scopePhrase}`;
        if (to !== undefined) return `set ${target} to \`${preview(to, 40) ?? ""}\`${scopePhrase}`;
      }
      return `modified ${what}${scopePhrase}`;

    case "Move":
      if (action.fromParent.label && action.toParent.label) {
        return `moved ${what} from ${action.fromParent.label} to ${action.toParent.label}`;
      }
      return `moved ${what} to position ${action.toPosition + 1}${scopePhrase}`;
  }
}

/**
 * Convert a list of EditActions into a SemanticChange array.
 * Each change carries both the action and its human-readable description.
 */
export function narrate(actions: EditAction[], opts: NarrationOptions = {}): SemanticChange[] {
  return dropRedundantUpdates(actions).map((action) => ({
    action,
    filePath: opts.filePath,
    description: narrateAction(action),
  }));
}

/**
 * Collapse Updates that describe the same edit twice.
 *
 * Renaming a function relabels the function node *and* changes the value of
 * its name identifier, so the raw edit script reports `parseConfig ->
 * loadConfig` twice. Renaming a variable used five times reports it five
 * times. Keyed on the from/to pair, preferring the named node, because that
 * is the one that carries the useful sentence.
 */
function dropRedundantUpdates(actions: EditAction[]): EditAction[] {
  const winner = new Map<string, number>();
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    if (action.type !== "Update") continue;
    const key = `${action.detail.from ?? ""}\0${action.detail.to ?? ""}`;
    const held = winner.get(key);
    if (held === undefined) {
      winner.set(key, i);
      continue;
    }
    const heldAction = actions[held] as UpdateAction;
    if (!heldAction.node.label && action.node.label) winner.set(key, i);
  }
  if (winner.size === 0) return actions;

  const keep = new Set(winner.values());
  return actions.filter((action, i) => action.type !== "Update" || keep.has(i));
}

/**
 * Produce a summary sentence for a changeset.
 * Groups changes by type for a high-level overview.
 */
export function summarize(changes: SemanticChange[], opts: NarrationOptions = {}): string {
  if (changes.length === 0) return "no logical changes";

  const counts: Record<string, number> = {};
  for (const c of changes) {
    const type = c.action.type;
    counts[type] = (counts[type] ?? 0) + 1;
  }

  const parts: string[] = [];
  if (counts.Insert) parts.push(`${counts.Insert} addition${counts.Insert > 1 ? "s" : ""}`);
  if (counts.Delete) parts.push(`${counts.Delete} deletion${counts.Delete > 1 ? "s" : ""}`);
  if (counts.Update) parts.push(`${counts.Update} modification${counts.Update > 1 ? "s" : ""}`);
  if (counts.Move) parts.push(`${counts.Move} move${counts.Move > 1 ? "s" : ""}`);

  const prefix = opts.filePath ? `${opts.filePath}: ` : "";
  return prefix + parts.join(", ");
}

export type OutputFormat = "terminal" | "json" | "markdown" | "llm" | "ndjson";

export interface FormatterOptions {
  format: OutputFormat;
  filePath?: string;
}

/**
 * Format a list of semantic changes for output.
 */
export function formatChanges(changes: SemanticChange[], opts: FormatterOptions): string {
  switch (opts.format) {
    case "json":
      return JSON.stringify(
        changes,
        (_key, val) => (typeof val === "bigint" ? val.toString() : val),
        2,
      );

    case "llm":
      return formatForLlm(changes);

    case "markdown": {
      if (changes.length === 0) return "_no logical changes_";
      const groups = groupByFile(changes);
      if (groups.length === 1 && !groups[0]![0]) {
        const header = opts.filePath ? `## ${opts.filePath}\n\n` : "## Changes\n\n";
        return header + changes.map((c) => `- ${c.description}`).join("\n");
      }
      return groups
        .map(
          ([file, group]) =>
            `## ${file ?? "Changes"}\n\n${group.map((c) => `- ${c.description}`).join("\n")}`,
        )
        .join("\n\n");
    }

    default: {
      if (changes.length === 0) return "no logical changes";
      const groups = groupByFile(changes);
      const line = (c: SemanticChange): string => `  ${iconForAction(c.action)} ${c.description}`;
      // A single file needs no heading; a changeset that spans files is
      // unreadable without one, since the descriptions never name the file.
      if (groups.length === 1) return changes.map(line).join("\n");
      return groups
        .map(([file, group]) => `${file ?? "(unknown file)"}\n${group.map(line).join("\n")}`)
        .join("\n\n");
    }
  }
}

/** Changes bucketed by file, preserving first-seen file order. */
function groupByFile(changes: SemanticChange[]): [string | undefined, SemanticChange[]][] {
  const groups = new Map<string | undefined, SemanticChange[]>();
  for (const change of changes) {
    const group = groups.get(change.filePath);
    if (group) group.push(change);
    else groups.set(change.filePath, [change]);
  }
  return [...groups];
}

/** Kinds that are never worth a line of their own in the LLM format. */
const ROLLED_UP_KINDS = new Set(["line", "word", "Comment", "comment"]);

const LLM_OP: Record<EditAction["type"], string> = {
  Insert: "+",
  Delete: "-",
  Update: "~",
  Move: ">",
};

/**
 * Dense line format for feeding a model.
 *
 * The point of this format is to cost less than the raw diff it replaces. The
 * previous JSON version cost *more* (110KB against a 100KB `git diff` on the
 * same changeset): pretty-printed, keys and the file path repeated on every
 * entry, empty fields still emitted, and one object per changed line of prose.
 *
 * So: one line per change, the file named once, and the changes that carry no
 * name (comments, bare expressions, prose lines) collapsed into a count. Every
 * named change carries its source line, which is the part that actually saves
 * a model tokens -- it can read the twenty lines around a change instead of
 * the whole file.
 */
function formatForLlm(changes: SemanticChange[]): string {
  const out: string[] = [];
  const groups = groupByFile(changes);
  const named = changes.filter((c) => !isMinor(c.action)).length;

  out.push(`differens/1 ${groups.length} files ${changes.length} changes ${named} named`);

  for (const [file, group] of groups) {
    out.push(`# ${file ?? "(unknown)"}`);
    const minor = new Map<string, number>();

    for (const { action } of group) {
      if (isMinor(action)) {
        const kind = humanizeKind(action.node.kind);
        minor.set(kind, (minor.get(kind) ?? 0) + 1);
        continue;
      }
      out.push(llmLine(action));
    }

    if (minor.size > 0) {
      const parts = [...minor].map(([kind, n]) => `${n} ${kind}${n > 1 ? "s" : ""}`);
      out.push(`* ${parts.join(", ")}`);
    }
  }

  return out.join("\n");
}

/** Carries no name a reader could act on, so it is only worth a tally. */
function isMinor(action: EditAction): boolean {
  if (ROLLED_UP_KINDS.has(action.node.kind)) return true;
  // Updates always name what changed, via from/to.
  return action.type !== "Update" && action.node.label === undefined;
}

function llmLine(action: EditAction): string {
  const kind = humanizeKind(action.node.kind);
  // A whole-file action is already under its own `# path` heading.
  const name = action.node.kind === "file" ? "" : (action.node.label ?? "");
  const at = action.node.line ? ` :${action.node.line}` : "";
  // Nearest named ancestor only. The full chain is mostly wrappers (Block,
  // Expression, file) and cost more than it told anyone. A scope that repeats
  // the node's own name says nothing either.
  const scope = nearestNamedAncestor(action);
  const within = scope && scope.label !== name ? ` < ${scope.kind} ${scope.label}` : "";
  const head = `${LLM_OP[action.type]} ${kind}${name ? ` ${name}` : ""}${at}${within}`;

  switch (action.type) {
    case "Update":
      return action.detail.kind === "Renamed"
        ? `${head} ${action.detail.from} -> ${action.detail.to}`
        : `${head} ${llmValue(action.detail.from)} -> ${llmValue(action.detail.to)}`;
    case "Move":
      return `${head} from ${action.fromParent.label ?? action.fromParent.kind}`;
    default:
      return head;
  }
}

function llmValue(value: string | undefined): string {
  if (value === undefined) return "none";
  return preview(value, 60) ?? '""';
}

function iconForAction(action: EditAction): string {
  switch (action.type) {
    case "Insert":
      return "+";
    case "Delete":
      return "-";
    case "Update":
      return "~";
    case "Move":
      return "→";
    default:
      return "•";
  }
}
