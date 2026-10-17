# differens-narrate

Describe typed edits and render human or machine output without parsing files again.

```rust
use differens_narrate::{narrate, format_changes, OutputFormat};
use differens_core::EditAction;

fn render(actions: &[EditAction]) -> Result<String, serde_json::Error> {
    let changes = narrate(actions, Some("src/main.rs"));
    format_changes(&changes, OutputFormat::Llm)
}
```

`narrate(actions: &[EditAction], file_path: Option<&str>) -> Vec<SemanticChange>` attaches descriptions and optional file identity. `narrate_action(&EditAction) -> String` describes one action. `humanize_kind(&str) -> String` formats canonical/parser concept names.

`OutputFormat` is `Terminal`, `Json`, `Markdown`, `Llm`, or `Ndjson`. `format_changes(changes, format) -> Result<String, serde_json::Error>` renders a change list. `readable_changes(changes, limit)` groups descendant edits into named constructs for presentation; `summarize(changes, compact)` returns a summary string.

`SemanticChange` owns an action, description, optional file path, and optional cross-file paths. Its `grouped` flag is internal presentation state and is skipped in JSON. Grouping does not redefine the underlying matching result.

For repository/directory envelopes, ordered file streaming, and cross-file correlation, use `differens-engine::report`. Single-file JSON is a change array; changeset JSON is an envelope. See [machine outputs](/guides/machine-outputs.html).
