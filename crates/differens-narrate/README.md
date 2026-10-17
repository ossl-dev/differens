# differens-narrate

Deterministic narration and presentation over core semantic edits.

`narrate(&[EditAction], Option<&str>)` creates `SemanticChange` values with
descriptions and optional file identity. `format_changes` renders terminal,
Markdown, JSON, NDJSON, or compact LLM output. `readable_changes` groups descendant
edits into named constructs for human presentation while preserving the original
actions for machine consumers.

Repository/directory envelopes, ordered streaming, and cross-file moves are
assembled by `differens-engine`; the narration crate does not read files or invoke
parsers.
