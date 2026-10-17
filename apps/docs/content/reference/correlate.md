# differens-correlate

Find declaration and whole-file moves between per-file edit lists.

```rust
use differens_correlate::{correlate, FileChanges, CorrelateOptions};

fn moves(files: &[FileChanges]) -> Vec<differens_correlate::CrossFileMatch> {
    correlate(files, CorrelateOptions {
        rename_similarity_threshold: 0.6,
    })
}
```

`FileChanges` contains `file_path: String` and `actions: Vec<EditAction>`. `correlate(&[FileChanges], CorrelateOptions) -> Vec<CrossFileMatch>` preserves input order and consumes each source/destination action at most once.

A match includes `node`, `from_file`, `to_file`, `modified`, `similarity`, and stable `ActionId { file, action }` values for `deletion` and `insertion`. IDs refer to the original ordered inputs; the correlator does not mutate those lists.

`is_move_candidate(&EditAction)` accepts named declaration and whole-file insertions/deletions. It rejects generic syntax fragments, updates, existing moves, and local variables inside named declarations. An unlabeled export wrapper can expose its named child.

Exact matching verifies full content/topology behind every hash match. Whole-file renames can match identical contents despite different path labels. Modified matching uses token-set Jaccard similarity, with the default threshold 0.6. Declaration names must agree for modified moves; whole-file path names do not affect similarity. Structure buckets exceeding 64 candidates are filtered by name and skipped if still ambiguous.

A similarity match is a heuristic. Unmatched edits remain ordinary insertions/deletions. Reporting a move does not prove a code extraction or a behavioral equivalence.
