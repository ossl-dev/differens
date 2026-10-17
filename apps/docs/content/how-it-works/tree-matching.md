# Tree matching

The core follows the GumTree lineage: anchor equal subtrees, recover surviving containers, then generate a typed edit script. It is deterministic and uses immutable flat trees plus separate mutable matching vectors.

## Matching passes

1. Top-down height buckets find equal-content candidates. Full field and topology verification establishes equality; matching hashes alone never do.
2. Same-kind roots pair, retaining the file/document wrapper through rewrites.
3. Named containers pair by their named ancestor path when the destination is unique.
4. Bottom-up matching ranks candidate ancestors using shared matched descendants, then compares up to four using an exact Dice score.
5. Leaf recovery aligns kinds inside matched parents with small-input LCS. More than 64 unmatched children use positional pairing.
6. Unique verified structure matches recover containers; leaf recovery runs again. A unique anonymous adapter-marked body may survive changing child shape.

Named-container identity can include an internal match key. Go methods use their
receiver type, so two types with the same method name keep separate scopes.
Changing the receiver variable or pointer form does not change that identity.

Identical code can move between parents within a compatible identity scope.
Candidate search also considers parents that have not yet matched; matched
parents provide affinity and recovery context.

## Edit scripts

`Update` describes a matched label or value change; `Move` describes relocation
or sibling reorder. `Delete` and `Insert` absorb entire removed or added subtrees.
Actions appear in that order.

Sibling reorders anchor named containers whose relative order is unchanged, then
align anonymous siblings between them with a longest increasing subsequence.
Repeated comments or attributes between declarations therefore do not force
unchanged declarations to appear as moves. The full edit script is a deterministic
heuristic and may not have the globally smallest number of edits.

Context runs nearest ancestor first and includes the root wrapper. Rename and value edits on the same node can produce separate actions; narration may deduplicate a declaration's matching name-token rename.

## Hashes

Legacy hashes are two 32-bit FNV streams folded into a 53-bit integer stored as `u64`. Strings are hashed as UTF-16 code units for compatibility. Content hashes cover kind, label, value, optional scalar type, and child content fingerprints. Structure hashes cover kind and child structure fingerprints.

Hash collisions only nominate candidates. The matcher and correlator verify real fields and topology. Cached structure verification prevents repeated full subtree scans along deep recovery paths.

## Storage and budgets

A node's subtree occupies a contiguous postorder interval. Parent IDs, child positions, subtree sizes, and heights are computed during validated construction. Traversal, equality, JSON encoding, and cleanup use flat ownership or explicit stacks.

Core `MatchOptions::max_nodes` defaults to `usize::MAX`. Tier adapters apply semantic analysis limits and fall back to lines. Bottom-up candidate caps help ordinary workloads but do not make every degenerate input linear. Measure representative input shapes before raising budgets.
