# differens-tiers

Byte-preserving tier routing, sequence diffing, data/markup parsing, and linked Tree-sitter grammars.

```rust
use differens_tiers::{diff_with_tier, SourcePresence};

let result = diff_with_tier(
    br#"{"port": 3000}"#,
    br#"{"port": 8080}"#,
    "old.json",
    "new.json",
    SourcePresence::default(),
);
assert!(!result.changes.is_empty());
```

`diff_with_tier(old: &[u8], new: &[u8], old_path: &str, new_path: &str, presence: SourcePresence) -> TierDiffResult` compares original bytes before decoding text. Presence distinguishes empty files from missing files. Set `old_exists` or `new_exists` to false for whole-file additions/deletions.

`TierDiffResult` exposes `changes`, `fallback: Option<String>`, `node_count`, and `tier`. JSON serializes the tier as a number from zero to five.

| Tier | Adapter |
| --- | --- |
| 0 | Binary bytes and optional in-process plugins |
| 1 | Raw line sequence |
| 2 | Prose words and paragraph movement |
| 3 | Markup elements, attributes, and text |
| 4 | Format-directed structured data |
| 5 | Code CSTs and semantic concepts |

`classify_file(path)` returns `FileInfo { path, extension, tier }`. `is_parseable(path)` reports whether a semantic parser is available. Classification alone does not promise a linked grammar.

## Parsing APIs

- `parse_code(source, extension, max_nodes)` returns a parsed tree or `ParseError`.
- `parse_data_as(source, extension)` selects JSON/JSONC/JSON5, YAML, TOML, INI, or environment syntax by format.
- `parse_data(source)` supplies format inference for callers without a path.
- `tree_from_value(&serde_json::Value)` returns a typed value tree.
- `parse_markup(source)` returns an element/attribute tree.
- `list_languages()` returns language names, semantic levels, and extensions; `has_grammar(extension)` checks availability.

Source parsers return `Result<Arc<Tree>, ParseError>`. Typed scalar metadata preserves changes such as numeric `1` to string `"1"`. Markup attributes include `href` and other non-label attributes. YAML supports nested indentation through its format parser.

Sequence helpers `diff_lines` and `diff_words` trim equal boundaries, use exact LCS for small inputs, and use bounded Myers processing for larger inputs. If the work budget runs out, unique unchanged anchors divide the remaining input into smaller gaps for positional comparison. Code/data/markup parser failures fall back directly to raw lines. Consult source constants and [benchmarks](/guides/benchmarks.html) for analysis budgets.

Binary plugins implement `BinaryDiffPlugin` and register through `register_binary_plugin`. The default adapter still reports changed bytes when no plugin answers. Byte identity is never inferred from lossy text decoding.
