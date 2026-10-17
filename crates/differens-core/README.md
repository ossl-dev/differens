# differens-core

Immutable semantic trees, verified subtree matching, and deterministic edit scripts.

```rust
use differens_core::{NodeSpec, TreeBuilder, MatchOptions, diff_trees};

fn document(value: &str) -> std::sync::Arc<differens_core::Tree> {
    let mut builder = TreeBuilder::new();
    let mut leaf = NodeSpec::new("number");
    leaf.value = Some(value.to_owned());
    let child = builder.push(leaf).unwrap();
    let mut root = NodeSpec::new("document");
    root.children.push(child);
    let root = builder.push(root).unwrap();
    builder.finish(root).unwrap()
}

let result = diff_trees(&document("1"), &document("2"), MatchOptions::default());
assert_eq!(result.changes.len(), 1);
assert_eq!(result.changes[0].action_type(), "Update");
```

Build children before parents, in source order. The builder rejects invalid
ranges, shared children, and disconnected or reordered subtrees. `NodeId` belongs
to one tree; use `NodeRef` when a node must keep its tree alive. Matching state
never mutates tree content.

`NodeSpec::match_key` can disambiguate same-named containers, such as Go methods
on different receiver types. Keys live in a sparse tree-level map and participate
in named-container matching paths. During matching, each hinted node and its
descendants stay within that `(kind, key)` scope; a nested hint starts a new
scope. Method names can change within one receiver. This prevents identical
bodies from being matched into an unrelated receiver or a newly added helper.
Keys are not content: legacy hashes, JSON, and `trees_equal` ignore them.
Detached nodes and flat snapshots retain their applicable keys.

Actions are `Insert`, `Delete`, `Update`, or `Move`. Rename and value updates
precede moves, deletions, and insertions. Added or removed subtrees produce one
action. Sibling reorders use a longest increasing subsequence. Named containers
that retain their relative order stay anchored while anonymous siblings align
within the remaining intervals. Context lists ancestors nearest first, including
the root.

Legacy hashes use UTF-16 code units and two folded FNV streams. Hash agreement
only selects candidates: exact content and topology checks establish equality.
Optional scalar type metadata prevents equal display text from hiding a type
change. Spans use UTF-8 byte offsets; source lines are one-based.

Adapters preserving the legacy JSON coordinate contract call
`TreeBuilder::set_legacy_source(source)` or `TreeBuilder::with_source(source)`.
Node fields remain UTF-8 byte spans; their serialized `byteRange` values use
UTF-16 code units. A shared map stores only non-ASCII character boundaries, with
no source-text retention or ASCII map allocation. Detachment and flat snapshots
compact conversion metadata to retained node boundaries, preserving absolute
UTF-16 coordinates without retaining unrelated source maps.

The default `serde` feature serializes legacy nested JSON without recursive tree
traversal. `NodeRef::shallow()` projects a node's metadata with no serialized
descendants. Disable default features for a core-only consumer without Serde.

Core matching has no default node limit. Set `MatchOptions::max_nodes` to request
an explicit `Fallback::Lines` result above a per-tree budget. Tier adapters apply
their own limits. Flat ownership, traversal, equality, and cleanup support deep
inputs without recursive stack growth; runtime still depends on tree shape and
the available matching evidence.
