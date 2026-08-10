/**
 * Differens Core: GumTree-style tree matching for semantic diffing.
 *
 * Pipeline: parse -> top-down isomorphic match -> bottom-up container
 * match -> Chawathe edit script with Move actions.
 *
 * Reference: Falleri et al. "Fine-grained and accurate source code
 * differencing" (ASE 2014, the GumTree paper).
 */

// 64-bit FNV-1a via BigInt. Birthday bound at 50k nodes:
// 32-bit: ~30% collision chance. 64-bit: ~0.000007%.
// Collision means wrongly matching different subtrees as identical.
const FNV_PRIME = 0x100000001b3n;
const FNV_SEED = 0xcbf29ce484222325n;

function hashFnv(seed: bigint, byte: number): bigint {
  return ((seed ^ BigInt(byte)) * FNV_PRIME) & 0xffffffffffffffffn;
}

function hashStr(seed: bigint, str: string): bigint {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = hashFnv(h, str.charCodeAt(i));
  return h;
}

// ---------- Node ----------

/** Position in source text */
export interface Position {
  row: number;
  column: number;
}

/** Byte range in source text */
export type ByteRange = [start: number, end: number];

export interface Node {
  kind: string;
  label?: string;
  value?: string;
  children: Node[];
  byteRange: ByteRange;
  height: number;
  contentHash: bigint;
  structureHash: bigint;
}

/** Options for building a Node tree */
export interface BuildNodeOptions {
  kind: string;
  label?: string;
  value?: string;
  children?: Node[];
  byteRange: ByteRange;
}

export function createNode(opts: BuildNodeOptions): Node {
  const children = opts.children ?? [];
  let maxChildHeight = 0;
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.height > maxChildHeight) maxChildHeight = children[i]!.height;
  }
  const height = maxChildHeight + 1;

  // Merkle hash: contentHash covers kind + label + value + children's contentHash
  let ch = hashStr(FNV_SEED, opts.kind);
  if (opts.label !== undefined) ch = hashStr(ch, opts.label);
  if (opts.value !== undefined) ch = hashStr(ch, opts.value);
  for (let i = 0; i < children.length; i++) {
    const kid = children[i]!;
    for (let b = 0n; b < 64n; b += 8n) ch = hashFnv(ch, Number((kid.contentHash >> b) & 0xffn));
  }

  // structureHash covers kind + children's structureHash, ignores label/value
  let sh = hashStr(FNV_SEED, opts.kind);
  for (let i = 0; i < children.length; i++) {
    const kid = children[i]!;
    for (let b = 0n; b < 64n; b += 8n) sh = hashFnv(sh, Number((kid.structureHash >> b) & 0xffn));
  }

  return { kind: opts.kind, label: opts.label, value: opts.value, children,
           byteRange: opts.byteRange, height, contentHash: ch, structureHash: sh };
}

// ---------- Edit actions ----------

export interface InsertAction {
  type: "Insert";
  node: Node;
  parent: Node;
  position: number;
  context: NodeContext[];
}

export interface DeleteAction {
  type: "Delete";
  node: Node;
  context: NodeContext[];
}

export interface UpdateAction {
  type: "Update";
  node: Node;
  detail: RenameDetail | ValueChangeDetail;
  context: NodeContext[];
}

export interface MoveAction {
  type: "Move";
  node: Node;
  fromParent: Node;
  toParent: Node;
  fromPosition: number;
  toPosition: number;
  context: NodeContext[];
}

export type EditAction = InsertAction | DeleteAction | UpdateAction | MoveAction;

/**
 * One level of ancestry for a changed node, nearest first.
 * Lets narration say "removed function X from class Y" and lets
 * AI tooling consume the full containment chain without re-parsing.
 */
export interface NodeContext {
  kind: string;
  label?: string;
}

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

// ---------- Matching options ----------

export interface MatchOptions {
  /** Subtrees shorter than this are not used as anchors (default 2) */
  minHeight: number;
  /** Minimum ratio of matched descendants to match containers (default 0.5) */
  bottomUpRatio: number;
  /** Maximum file size in bytes before falling back to line diff (default 5MB) */
  maxFileSize: number;
  /** Maximum node count before falling back to line diff (default 50_000) */
  maxNodes: number;
}

export const DEFAULT_OPTIONS: MatchOptions = {
  minHeight: 2,
  bottomUpRatio: 0.5,
  maxFileSize: 5 * 1024 * 1024,
  maxNodes: 50_000,
};

// ---------- Matching state ----------

interface MatchState {
  /** Map from old node ID to new node ID */
  oldToNew: Map<Node, Node>;
  /** Map from new node ID to old node ID */
  newToOld: Map<Node, Node>;
}

// ---------- Top-down matching ----------

/**
 * Phase 1: Isomorphic subtree matching.
 * Walk both trees top-down; when two nodes have identical content_hash
 * and height >= minHeight, map them as anchors.
 */
function topDownMatch(
  oldRoot: Node,
  newRoot: Node,
  state: MatchState,
): void {
  type Pair = [Node, Node];
  const stack: Pair[] = [[oldRoot, newRoot]];

  while (stack.length > 0) {
    const [oldNode, newNode] = stack.pop()!;

    if (state.oldToNew.has(oldNode) || state.newToOld.has(newNode)) {
      continue;
    }

    // Always match if same kind and content hash  --  perfect match regardless of height.
    // minHeight threshold only gates using this node as an anchor
    // for bottom-up container matching of its ancestors.
    if (
      oldNode.kind === newNode.kind &&
      oldNode.contentHash === newNode.contentHash
    ) {
      state.oldToNew.set(oldNode, newNode);
      state.newToOld.set(newNode, oldNode);

      // Recurse into children in order
      const minLen = Math.min(oldNode.children.length, newNode.children.length);
      for (let i = 0; i < minLen; i++) {
        stack.push([oldNode.children[i]!, newNode.children[i]!]);
      }
    } else if (
      // Leaf with same kind and same name: value changed, keep the node
      // matched so narration reports "changed value of X" instead of
      // a Delete+Insert pair.
      oldNode.kind === newNode.kind &&
      oldNode.children.length === 0 &&
      newNode.children.length === 0 &&
      oldNode.label !== undefined &&
      oldNode.label === newNode.label
    ) {
      state.oldToNew.set(oldNode, newNode);
      state.newToOld.set(newNode, oldNode);
    } else if (oldNode.kind === newNode.kind) {
      const minLen = Math.min(oldNode.children.length, newNode.children.length);
      for (let i = 0; i < minLen; i++) {
        stack.push([oldNode.children[i]!, newNode.children[i]!]);
      }
    }
  }
}

// ---------- Bottom-up matching ----------

/**
 * Phase 2: Container matching.
 * For unmatched nodes of the same kind, match them if enough descendants
 * are already matched (above the bottomUpRatio threshold).
 */
function bottomUpMatch(
  oldRoot: Node,
  newRoot: Node,
  state: MatchState,
  opts: MatchOptions,
): void {
  const unmatchedOld = collectUnmatched(oldRoot, state.oldToNew);
  const unmatchedNew = collectUnmatched(newRoot, state.newToOld);

  // Group unmatched by kind
  const byKindOld = groupByKind(unmatchedOld);
  const byKindNew = groupByKind(unmatchedNew);

  for (const [kind, oldNodes] of byKindOld) {
    const newNodes = byKindNew.get(kind);
    if (!newNodes || newNodes.length === 0) continue;

    // For each pair of same-kind nodes, compute overlap ratio
    for (const oldNode of oldNodes) {
      if (state.oldToNew.has(oldNode)) continue;

      let bestMatch: Node | null = null;
      let bestRatio = 0;

      for (const newNode of newNodes) {
        if (state.newToOld.has(newNode)) continue;

        const ratio = descendantOverlap(oldNode, newNode, state);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestMatch = newNode;
        }
      }

      if (bestMatch && bestRatio >= opts.bottomUpRatio) {
        state.oldToNew.set(oldNode, bestMatch);
        state.newToOld.set(bestMatch, oldNode);
      }
    }
  }
}

/** Collect all unmatched nodes via BFS */
function collectUnmatched(
  root: Node,
  matched: Map<Node, Node>,
): Node[] {
  const result: Node[] = [];
  const queue: Node[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!matched.has(node)) {
      result.push(node);
    }
    for (const child of node.children) {
      queue.push(child);
    }
  }

  return result;
}

function groupByKind(nodes: Node[]): Map<string, Node[]> {
  const map = new Map<string, Node[]>();
  for (const node of nodes) {
    const list = map.get(node.kind);
    if (list) list.push(node);
    else map.set(node.kind, [node]);
  }
  return map;
}

/**
 * Ratio of matched descendants between two nodes.
 * Counts descendants that are already in the matching.
 */
function descendantOverlap(
  oldNode: Node,
  newNode: Node,
  state: MatchState,
): number {
  const oldDescendants = collectDescendants(oldNode);
  const newDescendants = collectDescendants(newNode);

  // For leaf nodes with no descendants, fall back to content hash comparison
  if (oldDescendants.length === 0 && newDescendants.length === 0) {
    return oldNode.contentHash === newNode.contentHash ? 1.0 : 0;
  }

  let matched = 0;
  const newSet = new Set(newDescendants);

  for (const old of oldDescendants) {
    const partner = state.oldToNew.get(old);
    if (partner && newSet.has(partner)) {
      matched++;
    }
  }

  // Denominator is the smaller descendant set: a container that grew
  // (new key added to a config object) still matches its old self.
  const denom = Math.min(oldDescendants.length, newDescendants.length);
  return denom > 0 ? matched / denom : 0;
}

function collectDescendants(node: Node): Node[] {
  const result: Node[] = [];
  const stack: Node[] = [...node.children];

  while (stack.length > 0) {
    const n = stack.pop()!;
    result.push(n);
    for (const child of n.children) {
      stack.push(child);
    }
  }

  return result;
}

// ---------- Edit script generation ----------

/**
 * Phase 3: Generate edit script from the final matching.
 * Uses a Chawathe-style algorithm: walk old tree and detect
 * Insert, Delete, Update, and Move actions.
 */
function generateEditScript(
  oldRoot: Node,
  newRoot: Node,
  state: MatchState,
): EditAction[] {
  const actions: EditAction[] = [];

  // Build parent maps for O(1) parent lookups
  const oldParents = buildParentMap(oldRoot);
  const newParents = buildParentMap(newRoot);

  // Walk old tree to find deletions, updates, and moves
  walkAndDiff(oldRoot, state, actions, oldParents, newParents);

  return actions;
}

function buildParentMap(root: Node): Map<Node, Node> {
  const map = new Map<Node, Node>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.children) {
      map.set(child, node);
      stack.push(child);
    }
  }
  return map;
}

function walkAndDiff(
  oldNode: Node,
  state: MatchState,
  actions: EditAction[],
  oldParents: Map<Node, Node>,
  newParents: Map<Node, Node>,
): void {
  const partner = state.oldToNew.get(oldNode);

  if (!partner) {
    // Deleted: context is the ancestry chain in the OLD tree
    actions.push({
      type: "Delete",
      node: oldNode,
      context: ancestryChain(oldNode, oldParents),
    });
    return;
  }

  // Context for surviving nodes comes from the NEW tree
  const ctx = ancestryChain(partner, newParents);

  // Check for label changes (rename detection)
  if (oldNode.label !== partner.label) {
    if (oldNode.label && partner.label) {
      actions.push({
        type: "Update",
        node: partner,
        detail: {
          kind: "Renamed",
          from: oldNode.label,
          to: partner.label,
        },
        context: ctx,
      });
    } else if (oldNode.label || partner.label) {
      // One side has label, other doesn't  --  still a meaningful change
      actions.push({
        type: "Update",
        node: partner,
        detail: {
          kind: "Renamed",
          from: oldNode.label ?? "unnamed",
          to: partner.label ?? "unnamed",
        },
        context: ctx,
      });
    }
  }

  // Check for value changes
  if (oldNode.value !== partner.value) {
    actions.push({
      type: "Update",
      node: partner,
      detail: {
        kind: "ValueChanged",
        from: oldNode.value,
        to: partner.value,
      },
      context: ctx,
    });
  }

  // Check for move (same node matched to different parents)
  const oldParent = oldParents.get(oldNode);
  const newParent = newParents.get(partner);

  if (oldParent && newParent) {
    const oldParentPartner = state.oldToNew.get(oldParent);
    if (oldParentPartner !== newParent) {
      // Parent mismatch  --  this is a move
      actions.push({
        type: "Move",
        node: partner,
        fromParent: oldParent,
        toParent: newParent,
        fromPosition: oldParent.children.indexOf(oldNode),
        toPosition: newParent.children.indexOf(partner),
        context: ctx,
      });
    } else {
      // Same parent but different position  --  reorder
      const oldPos = oldParent.children.indexOf(oldNode);
      const newPos = newParent.children.indexOf(partner);
      if (oldPos !== newPos && oldPos >= 0 && newPos >= 0) {
        actions.push({
          type: "Move",
          node: partner,
          fromParent: oldParent,
          toParent: newParent,
          fromPosition: oldPos,
          toPosition: newPos,
          context: ctx,
        });
      }
    }
  }

  // Recurse into children
  for (const child of oldNode.children) {
    walkAndDiff(child, state, actions, oldParents, newParents);
  }
}

/**
 * Build the ancestry chain for a node, nearest ancestor first.
 * Root is excluded (it's just the file wrapper).
 */
function ancestryChain(node: Node, parents: Map<Node, Node>): NodeContext[] {
  const chain: NodeContext[] = [];
  let current = parents.get(node);
  while (current) {
    chain.push({ kind: current.kind, label: current.label });
    current = parents.get(current);
  }
  return chain;
}

// ---------- Main diff API ----------

export interface DiffResult {
  changes: EditAction[];
  /** Whether the pipeline fell back to a simpler mode */
  fallback?: "bytes" | "lines" | "generic_tree";
  /** Total nodes processed */
  nodeCount: number;
}

/**
 * Diff two Node trees using the GumTree-style matching algorithm.
 *
 * This is the main entry point for the diff core. Tier adapters parse
 * source into Nodes, then call this function to produce typed edit actions.
 */
export function diffTrees(
  oldRoot: Node,
  newRoot: Node,
  options: Partial<MatchOptions> = {},
): DiffResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Safety valve: skip tree diff on enormous inputs
  const oldNodeCount = countNodes(oldRoot);
  const newNodeCount = countNodes(newRoot);
  if (oldNodeCount > opts.maxNodes || newNodeCount > opts.maxNodes) {
    return {
      changes: [],
      fallback: "lines",
      nodeCount: oldNodeCount + newNodeCount,
    };
  }

  const state: MatchState = {
    oldToNew: new Map(),
    newToOld: new Map(),
  };

  // Phase 1: Top-down isomorphic matching
  topDownMatch(oldRoot, newRoot, state);

  // Phase 2: Bottom-up container matching
  bottomUpMatch(oldRoot, newRoot, state, opts);

  // Phase 3: Edit script generation
  const actions = generateEditScript(oldRoot, newRoot, state);

  // Detect inserts in new tree not matched to any old node.
  // Use the parent map already built for walkAndDiff.
  const allNewNodes = collectUnmatched(newRoot, state.newToOld);
  const movedNodes = new Set(actions.filter((a) => a.type === "Move").map((a) => a.node));
  const newParents = buildParentMap(newRoot);

  for (const node of allNewNodes) {
    if (movedNodes.has(node)) continue;
    const parent = newParents.get(node);
    if (parent) {
      const pos = parent.children.indexOf(node);
      actions.push({
        type: "Insert",
        node,
        parent,
        position: pos >= 0 ? pos : parent.children.length,
        context: ancestryChain(node, newParents),
      });
    }
  }

  return {
    changes: actions,
    nodeCount: oldNodeCount + newNodeCount,
  };
}

function countNodes(root: Node): number {
  let count = 1;
  for (const child of root.children) {
    count += countNodes(child);
  }
  return count;
}

// ---------- Utility: short-circuit hash comparison ----------

/**
 * Quick check: are two byte streams identical?
 * Use this before parsing to skip the full diff pipeline.
 */
export function fastUnchanged(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): boolean {
  if (oldBytes.length !== newBytes.length) return false;
  for (let i = 0; i < oldBytes.length; i++) {
    if (oldBytes[i] !== newBytes[i]) return false;
  }
  return true;
}

// ---------- Utility: node tree from simple key-value ----------

/**
 * Build a simple tree from a flat key-value object.
 * Used by T4 (config/data tier) for JSON/YAML value trees.
 */
export function treeFromValue(
  value: unknown,
  kind = "root",
): Node {
  if (value === null || value === undefined) {
    return createNode({
      kind,
      value: String(value),
      byteRange: [0, 1],
    });
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return createNode({
      kind: "leaf",
      label: kind,
      value: String(value),
      byteRange: [0, String(value).length],
    });
  }

  if (Array.isArray(value)) {
    const children = value.map((item, i) =>
      treeFromValue(item, `${kind}[${i}]`),
    );
    return createNode({
      kind: "array",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  if (typeof value === "object") {
    const children: Node[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      children.push(treeFromValue(val, key));
    }
    return createNode({
      kind: "object",
      label: kind,
      children,
      byteRange: [0, 1],
    });
  }

  return createNode({
    kind,
    value: String(value),
    byteRange: [0, 1],
  });
}
