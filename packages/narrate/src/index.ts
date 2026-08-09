/**
 * Narration Engine — edit script to natural language.
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
 * Convert a single EditAction to a human-readable description.
 */
export function narrateAction(
  action: EditAction,
  opts: NarrationOptions = {},
): string {
  const kind = humanizeKind(action.node.kind, opts.language);
  const name = action.node.label ?? "unnamed";

  switch (action.type) {
    case "Insert":
      return `added ${kind} \`${name}\``;

    case "Delete":
      return `removed ${kind} \`${name}\``;

    case "Update":
      if (action.detail.kind === "Renamed") {
        return `renamed ${kind} \`${action.detail.from}\` to \`${action.detail.to}\``;
      }
      if (action.detail.kind === "ValueChanged") {
        if (action.detail.from && action.detail.to) {
          return `changed ${kind} \`${name}\` from \`${action.detail.from}\` to \`${action.detail.to}\``;
        }
        return `changed ${kind} \`${name}\``;
      }
      return `modified ${kind} \`${name}\``;

    case "Move":
      if (action.fromParent.label && action.toParent.label) {
        return `moved ${kind} \`${name}\` from ${action.fromParent.label} to ${action.toParent.label}`;
      }
      return `moved ${kind} \`${name}\` to position ${action.toPosition + 1}`;

    default:
      return `changed ${kind} \`${name}\``;
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

// ---------- Whitespace-only detection ----------

/**
 * Check if all changes are value-only changes (no structural edits).
 * Returns true when there are no Insert/Delete/Move actions.
 */
export function isStructuralOnly(changes: SemanticChange[]): boolean {
  return changes.every(
    (c) => c.action.type === "Update" && c.action.detail.kind === "ValueChanged",
  );
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

export type OutputFormat = "terminal" | "json" | "markdown";

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
      return JSON.stringify(changes, null, 2);

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

function iconForAction(action: EditAction): string {
  switch (action.type) {
    case "Insert": return "+";
    case "Delete": return "-";
    case "Update": return "~";
    case "Move": return "→";
    default: return "•";
  }
}
