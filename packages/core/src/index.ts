/**
 * Differens — semantic diffing engine
 *
 * Parses code into trees, matches nodes structurally, and produces
 * typed edit scripts that describe what actually changed: renamed,
 * moved, extracted, added, removed, or reformatted only.
 *
 * @packageDocumentation
 */

// ---------- Node representation ----------

export interface Node {
  kind: string;
  label?: string;
  value?: string;
  children: Node[];
  byteRange: [start: number, end: number];
  contentHash: bigint;
  structureHash: bigint;
}

// ---------- Edit actions ----------

export type EditAction =
  | { type: "Insert"; node: Node; parent: Node; position: number }
  | { type: "Delete"; node: Node }
  | {
      type: "Update";
      node: Node;
      detail: RenameDetail | ValueChangeDetail;
    }
  | {
      type: "Move";
      node: Node;
      fromParent: Node;
      toParent: Node;
      fromPosition: number;
      toPosition: number;
    };

export interface RenameDetail {
  kind: "Renamed";
  from: string;
  to: string;
}

export interface ValueChangeDetail {
  kind: "ValueChanged";
  from?: string;
  to?: string;
}

// ---------- Semantic change ----------

export interface SemanticChange {
  action: EditAction;
  filePath?: string;
  fromFilePath?: string;
  toFilePath?: string;
  description: string;
}

// ---------- Core API (stubs) ----------

/**
 * Diff two source strings and return a list of typed semantic changes.
 * This is the main entry point — every tier adapter feeds into this.
 */
export function diff(
  _oldSource: string,
  _newSource: string,
): SemanticChange[] {
  // stub — will be implemented in M0
  return [];
}
