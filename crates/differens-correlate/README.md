# differens-correlate

Deterministic cross-file declaration and whole-file move detection over core edits.

`correlate(&[FileChanges], CorrelateOptions)` returns `Vec<CrossFileMatch>` without
mutating the supplied actions. Each match retains stable source/destination
`ActionId` values; each action is consumed at most once. Exact candidates undergo
full content/topology verification. Modified moves use bounded token-set Jaccard
similarity, with a default threshold of 0.6.

Only named declarations and whole-file insertions/deletions are candidates.
Generic syntax fragments and variables inside named declarations are excluded.
Whole-file renames compare content independently of path labels; modified
non-file candidates retain their declaration name. Similarity is a conservative
heuristic and does not prove behavioral equivalence.
