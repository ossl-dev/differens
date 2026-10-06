import type { EditAction, Node, NodeContext, SemanticChange } from "@ossl-dev/differens-core";
import { humanizeKind, narrateAction } from "./index";

const DECLARATIONS = new Set([
  "Function",
  "Method",
  "Class",
  "Interface",
  "TypeDef",
  "Enum",
  "Variable",
  "Struct",
  "Trait",
  "Module",
  "PropertySignature",
  "MethodSignature",
]);
const TEXT = new Set(["line", "word", "Comment", "comment"]);
const FILE_LIMIT = 20;
// Grouped descriptions must survive subsequent formatting and counting.
const grouped = new WeakSet<SemanticChange>();

function declaration(node: Node): Node | undefined {
  if (DECLARATIONS.has(node.kind) && node.label) return node;
  // An export is a wrapper around its declaration, not a useful subject.
  if (node.kind === "Export") {
    for (const child of node.children) {
      const named = declaration(child);
      if (named) return named;
    }
  }
  return undefined;
}

function owner(action: EditAction): NodeContext | undefined {
  return action.context.find((ctx) => ctx.label && DECLARATIONS.has(ctx.kind));
}

function counts(changes: SemanticChange[]): string {
  const totals = new Map<string, number>();
  const words = { Insert: "addition", Delete: "removal", Update: "update", Move: "move" };
  for (const { action } of changes) {
    const word = words[action.type];
    totals.set(word, (totals.get(word) ?? 0) + 1);
  }
  return [...totals].map(([word, n]) => `${n} ${word}${n === 1 ? "" : "s"}`).join(", ");
}

function details(changes: SemanticChange[]): string {
  const updates = changes.filter(({ action }) => action.type === "Update");
  if (
    updates.length === 0 &&
    changes.length <= 3 &&
    changes.every(
      ({ action }) =>
        (action.type === "Insert" || action.type === "Delete") && declaration(action.node),
    )
  ) {
    return changes
      .map(({ action }) => {
        const node = declaration(action.node)!;
        return `${action.type === "Insert" ? "added" : "removed"} ${humanizeKind(node.kind)} \`${node.label}\``;
      })
      .join(", ");
  }
  if (updates.length === 0 || updates.length > 3) return counts(changes);
  const values = updates.map(({ action }) => {
    if (action.type !== "Update") return "";
    const short = (value: string | undefined) => {
      const text = (value ?? "none").replace(/\s+/g, " ").trim();
      return text.length > 36 ? `${text.slice(0, 35)}…` : text;
    };
    return `\`${short(action.detail.from)}\` → \`${short(action.detail.to)}\``;
  });
  if (updates.length < changes.length)
    values.push(counts(changes.filter((c) => c.action.type !== "Update")));
  return values.join(", ");
}

/** Presentation only: the original actions remain available in JSON. */
export function readableChanges(changes: SemanticChange[], limit = FILE_LIMIT): SemanticChange[] {
  const files = new Map<string | undefined, SemanticChange[]>();
  for (const change of changes) {
    const group = files.get(change.filePath) ?? [];
    group.push(change);
    files.set(change.filePath, group);
  }
  const output: SemanticChange[] = [];
  for (const group of files.values()) {
    const entries: SemanticChange[] = [];
    const buckets = new Map<string, { subject: string; changes: SemanticChange[] }>();
    for (const change of group) {
      const { action } = change;
      if (grouped.has(change)) {
        entries.push(change);
        continue;
      }
      if (!action.node) {
        entries.push(change);
        continue;
      }
      const scope = owner(action);
      const candidate = declaration(action.node);
      // Local bindings and types are details of their enclosing declaration.
      const named =
        scope && candidate && ["Variable", "TypeDef", "Interface", "Enum"].includes(candidate.kind)
          ? undefined
          : candidate;
      if (
        named ||
        action.node.kind === "file" ||
        (action.node.label && ["leaf", "object", "array", "ConfigKey"].includes(action.node.kind))
      ) {
        const shown = named ? { ...action, node: named } : action;
        entries.push({
          ...change,
          action: shown,
          description: action.node.kind === "file" ? change.description : narrateAction(shown),
        });
        continue;
      }
      const subject = scope
        ? `${humanizeKind(scope.kind)} \`${scope.label}\``
        : TEXT.has(action.node.kind)
          ? humanizeKind(action.node.kind)
          : "file content";
      const key = JSON.stringify([
        scope?.kind,
        scope?.label,
        scope
          ? action.context.filter((ctx) => ctx.label && DECLARATIONS.has(ctx.kind))
          : action.context,
        subject,
      ]);
      const bucket = buckets.get(key);
      if (bucket) bucket.changes.push(change);
      else buckets.set(key, { subject, changes: [change] });
    }
    for (const { subject, changes: edits } of buckets.values()) {
      const entry: SemanticChange = {
        ...edits[0]!,
        action: {
          type: "Update",
          node: edits[0]!.action.node,
          detail: { kind: "ValueChanged" },
          context: edits[0]!.action.context,
        },
        description: `${edits.length === 1 && edits[0]!.action.type === "Update" ? "changed" : "modified"} ${subject} (${details(edits)})`,
      };
      grouped.add(entry);
      entries.push(entry);
    }
    output.push(...entries.slice(0, limit));
    if (entries.length > limit) {
      const rest = entries.slice(limit);
      output.push({
        ...rest[0]!,
        description: `${rest.length} more changes (${counts(rest)}); use --format=json for details`,
      });
    }
  }
  return output;
}
