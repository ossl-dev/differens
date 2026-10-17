# differens-tiers

Byte-preserving tier routing, sequence diffing, data/markup parsing, and linked Tree-sitter grammars.

## Main exports

| Rust API | Purpose |
| --- | --- |
| `classify_file`, `is_parseable`, `FileInfo`, `Tier` | Classify paths and check parser availability |
| `diff_with_tier`, `SourcePresence`, `TierDiffResult` | Compare source bytes with fallback handling |
| `parse_code`, `parse_data_as`, `parse_data`, `parse_markup` | Parse one source into a tree |
| `tree_from_value` | Convert a `serde_json::Value` into a typed tree |
| `list_languages`, `has_grammar`, `LanguageInfo` | Inspect compiled language coverage |
| `parse_cache_stats`, `clear_parse_cache`, `ParseCacheStats` | Inspect or release this thread's cached trees |
| `diff_lines`, `diff_words`, `diff_prose_actions` | Use shared text comparison directly |
| `BinaryDiffPlugin`, `register_binary_plugin`, `unregister_binary_plugin` | Supply in-process binary adapters |

## Compare bytes

```rust
use differens_tiers::{diff_with_tier, SourcePresence};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let result = diff_with_tier(
        br#"{"port": 3000}"#,
        br#"{"port": 8080}"#,
        "old.json",
        "new.json",
        SourcePresence::default(),
    );
    assert!(!result.changes.is_empty());
    Ok(())
}
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

## Classify and parse code

```rust
use differens_tiers::{Tier, classify_file, has_grammar, parse_code};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let info = classify_file("src/math.ts");
    assert_eq!(info.tier, Tier::Code);
    assert!(has_grammar("ts"));
    let tree = parse_code("function total(a: number) { return a; }", "ts", 50_000)?;
    println!("{} {}", info.extension, tree.root_ref().kind);
    Ok(())
}
```

```text
ts file
```

Pass extensions without a leading dot to `has_grammar` and `parse_code`. The
`code` Cargo feature is enabled by default. With it disabled, the library still
provides data, markup, prose, lines, and binary handling, but no linked code
grammars.

## File presence and whole-file edits

`SourcePresence::default()` means both files exist, even if a source slice is
empty. Set the absent side explicitly when collecting file additions/removals:

```rust
use differens_tiers::{SourcePresence, diff_with_tier};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let result = diff_with_tier(
        b"",
        b"export const enabled = true;\n",
        "settings.ts",
        "settings.ts",
        SourcePresence { old_exists: false, new_exists: true },
    );
    assert_eq!(result.changes.len(), 1);
    assert_eq!(result.changes[0].action_type(), "Insert");
    assert_eq!(result.changes[0].node().kind, "file");
    Ok(())
}
```

A whole-file addition is one file action. It is not parsed into a separate
insertion for every declaration. Identical sources with equal presence return
no actions before parsing.

## Parse cache

Each native worker reuses its parser instances and a bounded content cache.
Cache entries require both content hash and full source equality. A thread keeps
at most 64 entries, 50,000 cached nodes, and 2,000,000 source bytes; oversized
trees are not cached. Cache state is process-local and thread-local, so a new CLI
process does not inherit it. `parse_cache_stats()` inspects the calling thread;
`clear_parse_cache()` drops its cached trees while keeping reusable parsers.

## Binary plugin contract

A plugin gets original bytes. It returns `Ok(Some(actions))` to answer,
`Ok(None)` to decline, or an error if it cannot process the input. Empty answers,
errors, and panics do not hide changed bytes; the router can try the next plugin
and retain the default byte-length report.

This complete example registers a plugin that declines `.bin` inputs, allowing
the default handling to continue:

```rust
use std::sync::Arc;
use differens_core::EditAction;
use differens_tiers::{BinaryDiffPlugin, register_binary_plugin, unregister_binary_plugin};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    struct ExamplePlugin;
    impl BinaryDiffPlugin for ExamplePlugin {
        fn id(&self) -> &str { "example" }
        fn extensions(&self) -> &[&str] { &["bin"] }
        fn diff(
            &self,
            _old: &[u8],
            _new: &[u8],
        ) -> Result<Option<Vec<EditAction>>, Box<dyn std::error::Error + Send + Sync>> {
            Ok(None)
        }
    }
    register_binary_plugin(Arc::new(ExamplePlugin));
    assert!(unregister_binary_plugin("example"));
    Ok(())
}
```

Registration is a Rust API, not a CLI flag for loading shared libraries from
disk. The first nonempty successful plugin answer wins.
