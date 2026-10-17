//! Code parsing and semantic extraction from the frozen grammar registry.
#[cfg(feature = "code")]
mod concepts;
#[cfg(feature = "code")]
#[allow(
    unsafe_code,
    reason = "isolated bindings to checked-in generated tree-sitter C grammars"
)]
mod grammar;
#[cfg(feature = "code")]
mod labels;

use crate::ParseError;
use differens_core::{NodeSpec, Tree, TreeBuilder};
use std::sync::Arc;

#[derive(Clone, Debug, serde::Serialize)]
pub struct LanguageInfo {
    pub language: &'static str,
    pub level: &'static str,
    pub extensions: &'static [&'static str],
}

const LANGUAGES: &[LanguageInfo] = &[
    LanguageInfo {
        language: "javascript",
        level: "L6",
        extensions: &["js", "mjs", "cjs", "jsx"],
    },
    LanguageInfo {
        language: "typescript",
        level: "L6",
        extensions: &["ts", "mts", "cts", "tsx"],
    },
    LanguageInfo {
        language: "python",
        level: "L6",
        extensions: &["py"],
    },
    LanguageInfo {
        language: "rust",
        level: "L6",
        extensions: &["rs"],
    },
    LanguageInfo {
        language: "go",
        level: "L6",
        extensions: &["go"],
    },
    LanguageInfo {
        language: "c",
        level: "L6",
        extensions: &["c"],
    },
    LanguageInfo {
        language: "cpp",
        level: "L6",
        extensions: &["cpp"],
    },
    LanguageInfo {
        language: "java",
        level: "L6",
        extensions: &["java"],
    },
    LanguageInfo {
        language: "ruby",
        level: "L6",
        extensions: &["rb"],
    },
    LanguageInfo {
        language: "php",
        level: "L6",
        extensions: &["php"],
    },
    LanguageInfo {
        language: "swift",
        level: "L6",
        extensions: &["swift"],
    },
    LanguageInfo {
        language: "kotlin",
        level: "L6",
        extensions: &["kt"],
    },
    LanguageInfo {
        language: "csharp",
        level: "L6",
        extensions: &["cs"],
    },
    LanguageInfo {
        language: "scala",
        level: "L6",
        extensions: &["scala"],
    },
    LanguageInfo {
        language: "lua",
        level: "L6",
        extensions: &["lua"],
    },
    LanguageInfo {
        language: "bash",
        level: "L6",
        extensions: &["sh", "bash", "zsh"],
    },
];

fn language_info(extension: &str) -> Option<&'static LanguageInfo> {
    if cfg!(feature = "code") {
        LANGUAGES
            .iter()
            .find(|info| info.extensions.contains(&extension))
    } else {
        None
    }
}

/// List the enabled language extractors and their registered file extensions.
#[must_use]
pub fn list_languages() -> Vec<LanguageInfo> {
    if cfg!(feature = "code") {
        LANGUAGES.to_vec()
    } else {
        Vec::new()
    }
}

/// Whether this build includes the extension's frozen grammar.
#[must_use]
pub fn has_grammar(extension: &str) -> bool {
    language_info(extension).is_some()
}

/// Parse code using a frozen native grammar, or wrap unsupported code as lines.
/// Native CST ranges retain UTF-8 byte offsets internally, with legacy UTF-16
/// coordinates on serialization. Unsupported line wrappers use synthetic local
/// UTF-16 widths.
///
/// # Errors
/// Returns an error on a grammar load failure, cancellation, invalid tree, or exceeded budget.
pub fn parse_code(
    source: &str,
    extension: &str,
    max_nodes: usize,
) -> Result<Arc<Tree>, ParseError> {
    #[cfg(feature = "code")]
    if let Some(info) = language_info(extension) {
        return native::parse(
            source,
            match extension {
                "mjs" | "cjs" | "jsx" => "js",
                "mts" | "cts" => "ts",
                "bash" | "zsh" => "sh",
                _ => extension,
            },
            if info.language == "javascript" {
                "typescript"
            } else {
                info.language
            },
            max_nodes,
        );
    }
    let mut builder = TreeBuilder::new();
    let mut children = Vec::new();
    for (i, line) in source.split('\n').enumerate() {
        if i.saturating_add(2) > max_nodes {
            return Err(ParseError::Budget);
        }
        let mut spec = NodeSpec::new("line");
        spec.label = Some(format!("L{}", i + 1));
        spec.value = Some(line.to_owned());
        // Unsupported-code lines have local synthetic legacy UTF-16 widths.
        spec.byte_range = [0, line.encode_utf16().count()];
        children.push(builder.push(spec)?);
    }
    let mut root = NodeSpec::new("file");
    root.label = Some(extension.to_owned());
    root.children = children;
    root.byte_range = [0, source.encode_utf16().count()];
    let id = builder.push(root)?;
    Ok(builder.finish(id)?)
}

/// Retained parse-cache resources for the current worker thread.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ParseCacheStats {
    pub hits: usize,
    pub misses: usize,
    pub entries: usize,
    pub nodes: usize,
    pub source_bytes: usize,
}

/// Inspect this thread's bounded parse cache without affecting eviction order.
#[must_use]
pub fn parse_cache_stats() -> ParseCacheStats {
    #[cfg(feature = "code")]
    {
        native::cache_stats()
    }
    #[cfg(not(feature = "code"))]
    {
        ParseCacheStats::default()
    }
}

/// Release this thread's cached source trees, retaining reusable parser instances.
pub fn clear_parse_cache() {
    #[cfg(feature = "code")]
    native::clear_cache();
}

#[cfg(feature = "code")]
mod native {
    use super::{
        Arc, NodeSpec, ParseCacheStats, ParseError, Tree, TreeBuilder, concepts, grammar, labels,
    };
    use std::{
        cell::RefCell,
        collections::{HashMap, VecDeque},
    };
    use tree_sitter::{Node, Parser};
    struct Entry {
        extension: String,
        hash: u64,
        source: String,
        tree: Arc<Tree>,
    }
    #[derive(Default)]
    struct ParseState {
        parsers: HashMap<String, Parser>,
        entries: VecDeque<Entry>,
        bytes: usize,
        nodes: usize,
        hits: usize,
        misses: usize,
    }
    thread_local! { static STATE:RefCell<ParseState> = RefCell::default(); }
    pub(super) fn cache_stats() -> ParseCacheStats {
        STATE.with(|state| {
            let state = state.borrow();
            ParseCacheStats {
                hits: state.hits,
                misses: state.misses,
                entries: state.entries.len(),
                nodes: state.nodes,
                source_bytes: state.bytes,
            }
        })
    }
    pub(super) fn clear_cache() {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.entries.clear();
            state.bytes = 0;
            state.nodes = 0;
            state.hits = 0;
            state.misses = 0;
        });
    }
    pub(super) fn parse(
        source: &str,
        extension: &str,
        language: &str,
        max_nodes: usize,
    ) -> Result<Arc<Tree>, ParseError> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let hash = differens_core::hash_text(source);
            if let Some(index) = state.entries.iter().position(|entry| {
                entry.extension == extension && entry.hash == hash && entry.source == source
            }) {
                let entry = state.entries.remove(index).ok_or(ParseError::Budget)?;
                if entry.tree.len() > max_nodes {
                    state.entries.push_back(entry);
                    return Err(ParseError::Budget);
                }
                state.hits += 1;
                let result = Arc::clone(&entry.tree);
                state.entries.push_back(entry);
                return Ok(result);
            }
            state.misses += 1;
            if !state.parsers.contains_key(extension) {
                let grammar = grammar::get(extension).ok_or(ParseError::Unsupported)?;
                let mut parser = Parser::new();
                parser
                    .set_language(&grammar)
                    .map_err(|error| ParseError::Syntax(error.to_string()))?;
                state.parsers.insert(extension.to_owned(), parser);
            }
            let parser = state
                .parsers
                .get_mut(extension)
                .ok_or(ParseError::Unsupported)?;
            let syntax = parser.parse(source, None).ok_or(ParseError::Cancelled)?;
            let tree = convert(syntax.root_node(), source, language, max_nodes)?;
            if tree.len() <= 50_000 && source.len() <= 2_000_000 {
                while !state.entries.is_empty()
                    && (state.entries.len() >= 64
                        || state.bytes + source.len() > 2_000_000
                        || state.nodes + tree.len() > 50_000)
                {
                    if let Some(entry) = state.entries.pop_front() {
                        state.bytes -= entry.source.len();
                        state.nodes -= entry.tree.len();
                    }
                }
                state.bytes += source.len();
                state.nodes += tree.len();
                state.entries.push_back(Entry {
                    extension: extension.to_owned(),
                    hash,
                    source: source.to_owned(),
                    tree: Arc::clone(&tree),
                });
            }
            Ok(tree)
        })
    }
    fn convert(
        root: Node<'_>,
        source: &str,
        language: &str,
        max_nodes: usize,
    ) -> Result<Arc<Tree>, ParseError> {
        struct Frame<'a> {
            syntax: Node<'a>,
            children: Vec<differens_core::NodeId>,
            label: Option<String>,
            depth: u32,
        }
        let mut builder = TreeBuilder::new();
        builder.set_legacy_source(source);
        let mut stack: Vec<Frame<'_>> = Vec::new();
        let mut cursor = root.walk();
        let mut count = 0;
        let mut result = None;
        loop {
            let syntax = cursor.node();
            if let Some(parent) = stack.last_mut() {
                if cursor.field_name() == Some("name") && parent.label.is_none() {
                    parent.label = Some(source[syntax.byte_range()].to_owned());
                }
            }
            if syntax.is_named() {
                count += 1;
                if count > max_nodes || (max_nodes != usize::MAX && cursor.depth() > 256) {
                    return Err(ParseError::Budget);
                }
                stack.push(Frame {
                    syntax,
                    children: Vec::new(),
                    label: None,
                    depth: cursor.depth(),
                });
            } else if !matches!(
                syntax.kind(),
                "(" | ")" | "{" | "}" | "[" | "]" | ";" | "," | "'" | "\"" | "`"
            ) {
                count += 1;
                if count > max_nodes {
                    return Err(ParseError::Budget);
                }
                let mut spec = NodeSpec::new("token");
                spec.value = Some(source[syntax.byte_range()].to_owned());
                spec.byte_range = [syntax.start_byte(), syntax.end_byte()];
                spec.line = Some(syntax.start_position().row + 1);
                if let Some(frame) = stack.last_mut() {
                    frame.children.push(builder.push(spec)?);
                }
            }
            if cursor.goto_first_child() {
                continue;
            }
            loop {
                if stack
                    .last()
                    .is_some_and(|frame| frame.depth == cursor.depth())
                {
                    let frame = stack.pop().ok_or(ParseError::Budget)?;
                    let mut spec = NodeSpec::new(concepts::concept(language, frame.syntax.kind()));
                    spec.label = frame
                        .label
                        .or_else(|| labels::extract(language, frame.syntax, source));
                    spec.value = if !stack.is_empty() && frame.children.is_empty() {
                        Some(source[frame.syntax.byte_range()].to_owned())
                    } else {
                        None
                    };
                    spec.children = frame.children;
                    spec.byte_range = [frame.syntax.start_byte(), frame.syntax.end_byte()];
                    spec.line = Some(frame.syntax.start_position().row + 1);
                    spec.match_key = labels::match_key(language, frame.syntax, source);
                    spec.emit_match_by_kind = true;
                    spec.match_by_kind = matches!(
                        frame.syntax.kind(),
                        "class_body" | "statement_block" | "block"
                    );
                    let id = builder.push(spec)?;
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(id);
                    } else {
                        result = Some(id);
                    }
                }
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    return Ok(builder.finish(result.ok_or(ParseError::Cancelled)?)?);
                }
            }
        }
    }
}
