/**
 * Narration Engine  --  edit script to natural language.
 *
 * Converts typed EditActions into human-readable sentences.
 * Template-based, deterministic, and fast. Per-language vocabulary
 * handles fn/def/func → "function" mapping.
 *
 * @packageDocumentation
 */

import type { EditAction, SemanticChange } from "@differens/core";

// ---------- Vocabulary ----------

/** Map language-specific keywords to generic English concepts */
const VOCABULARY: Record<string, Record<string, string>> = {
  typescript: { fn: "function", def: "function", func: "function" },
  python: {
    def: "function",
    class: "class",
    import: "import",
    return: "return",
  },
  rust: { fn: "function", struct: "struct", enum: "enum", trait: "trait" },
  go: { func: "function", type: "type", var: "variable", const: "constant" },
};

function humanizeKind(kind: string, language?: string): string {
  const langVocab = language ? VOCABULARY[language] : undefined;
  const lower = kind.toLowerCase();
  if (langVocab?.[lower]) return langVocab[lower]!;

  // Convert snake_case/camelCase to spaces
  return kind
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

// ---------- Narration ----------

export interface NarrationOptions {
  language?: string;
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

/**
 * Convert a single EditAction to a human-readable description.
 * Includes the containing scope when one exists:
 * "removed function `parse` from class `Config`",
 * "changed value of variable `port` in function `listen`".
 */
export function narrateAction(
  action: EditAction,
  opts: NarrationOptions = {},
): string {
  const kind = humanizeKind(action.node.kind, opts.language);
  const name = action.node.label ?? "unnamed";
  const scope = nearestNamedAncestor(action);
  const scopePhrase = scope ? ` in ${scope.kind} \`${scope.label}\`` : "";

  switch (action.type) {
    case "Insert":
      return `added ${kind} \`${name}\`${scopePhrase}`;

    case "Delete":
      return scope
        ? `removed ${kind} \`${name}\` from ${scope.kind} \`${scope.label}\``
        : `removed ${kind} \`${name}\``;

    case "Update":
      if (action.detail.kind === "Renamed") {
        return `renamed ${kind} \`${action.detail.from}\` to \`${action.detail.to}\`${scopePhrase}`;
      }
      if (action.detail.kind === "ValueChanged") {
        if (action.detail.from !== undefined && action.detail.to !== undefined) {
          return `changed value of ${kind} \`${name}\` from \`${action.detail.from}\` to \`${action.detail.to}\`${scopePhrase}`;
        }
        if (action.detail.from !== undefined) {
          return `removed value of ${kind} \`${name}\`${scopePhrase}`;
        }
        if (action.detail.to !== undefined) {
          return `set value of ${kind} \`${name}\` to \`${action.detail.to}\`${scopePhrase}`;
        }
      }
      return `modified ${kind} \`${name}\`${scopePhrase}`;

    case "Move":
      if (action.fromParent.label && action.toParent.label) {
        return `moved ${kind} \`${name}\` from ${action.fromParent.label} to ${action.toParent.label}`;
      }
      return `moved ${kind} \`${name}\` to position ${action.toPosition + 1}${scopePhrase}`;
  }
}

/**
 * Convert a list of EditActions into a SemanticChange array.
 * Each change carries both the action and its human-readable description.
 */
export function narrate(
  actions: EditAction[],
  opts: NarrationOptions = {},
): SemanticChange[] {
  return actions.map((action) => ({
    action,
    filePath: opts.filePath,
    description: narrateAction(action, opts),
  }));
}

// ---------- Summary rolling-up ----------

/**
 * Produce a summary sentence for a changeset.
 * Groups changes by type for a high-level overview.
 */
export function summarize(
  changes: SemanticChange[],
  opts: NarrationOptions = {},
): string {
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

// ---------- Output formatters ----------

export type OutputFormat = "terminal" | "json" | "markdown" | "llm";

export interface FormatterOptions {
  format: OutputFormat;
  filePath?: string;
}

/**
 * Format a list of semantic changes for output.
 */
export function formatChanges(
  changes: SemanticChange[],
  opts: FormatterOptions,
): string {
  switch (opts.format) {
    case "json":
      return JSON.stringify(changes, (_key, val) =>
        typeof val === "bigint" ? val.toString() : val, 2);

    case "llm":
      return formatForLlm(changes);

    case "markdown": {
      if (changes.length === 0) return "_no logical changes_";
      const header = opts.filePath ? `## ${opts.filePath}\n\n` : "## Changes\n\n";
      const items = changes.map((c) => `- ${c.description}`).join("\n");
      return header + items;
    }

    case "terminal":
    default: {
      if (changes.length === 0) return "no logical changes";
      return changes.map((c) => `  ${iconForAction(c.action)} ${c.description}`).join("\n");
    }
  }
}

/**
 * Compact JSON designed for LLM consumption: one object per change,
 * flat fields, no BigInt, no nested action objects. Includes the
 * containment chain so a model gets full context without the raw diff.
 */
function formatForLlm(changes: SemanticChange[]): string {
  const items = changes.map((c) => {
    const a = c.action;
    const base = {
      file: c.filePath ?? null,
      kind: a.node.kind,
      name: a.node.label ?? null,
      context: a.context.map((ctx) =>
        ctx.label ? `${ctx.kind} ${ctx.label}` : ctx.kind,
      ),
    };
    switch (a.type) {
      case "Insert":
        return { ...base, action: "added", parent: a.parent.kind };
      case "Delete":
        return { ...base, action: "removed" };
      case "Update":
        if (a.detail.kind === "Renamed") {
          return { ...base, action: "renamed", from: a.detail.from, to: a.detail.to };
        }
        return {
          ...base,
          action: a.detail.from === undefined ? "set" : a.detail.to === undefined ? "unset" : "changed",
          from: a.detail.from ?? null,
          to: a.detail.to ?? null,
        };
      case "Move":
        return {
          ...base,
          action: "moved",
          fromParent: a.fromParent.label ?? a.fromParent.kind,
          toParent: a.toParent.label ?? a.toParent.kind,
        };
    }
  });
  return JSON.stringify(items, null, 2);
}

function iconForAction(action: EditAction): string {
  switch (action.type) {
    case "Insert": return "+";
    case "Delete": return "-";
    case "Update": return "~";
    case "Move": return "→";
    default: return "•";
  }
}
