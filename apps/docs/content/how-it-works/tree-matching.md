# Tree matching

The core follows the GumTree lineage: anchor equal subtrees, recover surviving containers, then generate a typed edit script. It is deterministic and uses immutable flat trees plus separate mutable matching vectors.

## Matching passes

1. Top-down height buckets find equal-content candidates. Full field and topology verification establishes equality; matching hashes alone never do.
2. Same-kind roots pair, retaining the file/document wrapper through rewrites.
3. Named containers pair by their named ancestor path when the destination is unique.
4. Bottom-up matching ranks candidate ancestors using shared matched descendants, then compares up to four using an exact Dice score.
5. Leaf recovery aligns kinds inside matched parents with small-input LCS. More than 64 unmatched children use positional pairing.
6. Unique verified structure matches recover containers; leaf recovery runs again. A unique anonymous adapter-marked body may survive changing child shape.

Identical code can move between parents. Candidate search is not restricted to already-matched parents; those parents provide affinity and recovery context.

## Edit scripts

`Update` describes a matched label/value change; `Move` describes relocation or sibling reorder. `Delete` and `Insert` absorb entire removed/added subtrees. Actions appear in that order. Sibling reorders keep a longest increasing subsequence, minimizing moves within that ordering problem. The whole heuristic tree script is not a globally minimal tree-edit-distance proof.

Context runs nearest ancestor first and includes the root wrapper. Rename and value edits on the same node can produce separate actions; narration may deduplicate a declaration's matching name-token rename.

## Hashes

Legacy hashes are two 32-bit FNV streams folded into a 53-bit integer stored as `u64`. Strings are hashed as UTF-16 code units for compatibility. Content hashes cover kind, label, value, optional scalar type, and child content fingerprints. Structure hashes cover kind and child structure fingerprints.

Hash collisions only nominate candidates. The matcher and correlator verify real fields and topology. Cached structure verification prevents repeated full subtree scans along deep recovery paths.

## Storage and budgets

A node's subtree occupies a contiguous postorder interval. Parent IDs, child positions, subtree sizes, and heights are computed during validated construction. Traversal, equality, JSON encoding, and cleanup use flat ownership or explicit stacks.

Core `MatchOptions::max_nodes` defaults to `usize::MAX`. Tier adapters apply semantic analysis limits and fall back to lines. Bottom-up candidate caps help ordinary workloads but do not make every degenerate input linear. Measure representative input shapes before raising budgets.
