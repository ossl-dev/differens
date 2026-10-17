use crate::{
    binary::binary_plugins_for,
    code::has_grammar,
    data::parse_data_as,
    markup::parse_markup,
    parse_code,
    sequence::{HunkDiff, HunkKind},
    single_node,
};
use differens_core::{EditAction, MatchOptions, NodeSpec, UpdateDetail, diff_trees};
use std::fmt::Write;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Tier {
    Binary = 0,
    Raw = 1,
    Prose = 2,
    Markup = 3,
    Data = 4,
    Code = 5,
}
impl serde::Serialize for Tier {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}
#[derive(Clone, Debug)]
pub struct FileInfo {
    pub path: String,
    pub extension: String,
    pub tier: Tier,
}
#[derive(Clone, Copy, Debug)]
pub struct SourcePresence {
    pub old_exists: bool,
    pub new_exists: bool,
}
impl Default for SourcePresence {
    fn default() -> Self {
        Self {
            old_exists: true,
            new_exists: true,
        }
    }
}
pub type Presence = SourcePresence;
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierDiffResult {
    pub changes: Vec<EditAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    pub node_count: usize,
    pub tier: Tier,
}

#[must_use]
pub fn classify_file(path: &str) -> FileInfo {
    let lower = path.to_ascii_lowercase();
    let extension = lower.rsplit('.').next().unwrap_or("");
    let tier = if crate::is_binary_extension(extension) {
        Tier::Binary
    } else if matches!(
        extension,
        "json" | "jsonc" | "json5" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "env"
    ) || lower.ends_with(".env.local")
    {
        Tier::Data
    } else if matches!(extension, "html" | "htm" | "xml" | "svg" | "xaml" | "plist") {
        Tier::Markup
    } else if matches!(
        extension,
        "md" | "mdx" | "rst" | "adoc" | "org" | "csv" | "tsv" | "graphql" | "dockerfile"
    ) {
        Tier::Raw
    } else if matches!(extension, "txt" | "log")
        || ["license", "readme", "changelog", "authors"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
    {
        Tier::Prose
    } else if matches!(
        extension,
        "rs" | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "go"
            | "java"
            | "kt"
            | "py"
            | "rb"
            | "php"
            | "swift"
            | "cs"
            | "js"
            | "mjs"
            | "cjs"
            | "ts"
            | "mts"
            | "cts"
            | "jsx"
            | "tsx"
            | "scala"
            | "lua"
            | "sh"
            | "sql"
            | "bash"
            | "zsh"
            | "fish"
            | "css"
            | "scss"
            | "less"
            | "vue"
            | "svelte"
            | "astro"
    ) {
        Tier::Code
    } else {
        Tier::Raw
    };
    FileInfo {
        path: path.to_owned(),
        extension: extension.to_owned(),
        tier,
    }
}
#[must_use]
pub fn is_parseable(path: &str) -> bool {
    let info = classify_file(path);
    matches!(info.tier, Tier::Data | Tier::Markup)
        || info.tier == Tier::Code && has_grammar(&info.extension)
}
#[must_use]
pub fn diff_with_tier(
    old: &[u8],
    new: &[u8],
    old_path: &str,
    new_path: &str,
    presence: Presence,
) -> TierDiffResult {
    let info = classify_file(old_path);
    if !presence.old_exists && presence.new_exists {
        return whole_file(true, new_path, new);
    }
    if !presence.new_exists && presence.old_exists {
        return whole_file(false, old_path, old);
    }
    if old == new {
        return TierDiffResult {
            changes: Vec::new(),
            fallback: None,
            node_count: 0,
            tier: info.tier,
        };
    }
    let texts = (std::str::from_utf8(old), std::str::from_utf8(new));
    if info.tier == Tier::Binary
        || texts.0.is_err()
        || texts.1.is_err()
        || (info.tier == Tier::Raw
            && (old[..old.len().min(8192)].contains(&0) || new[..new.len().min(8192)].contains(&0)))
    {
        return binary(old, new, &info.extension);
    }
    let (Ok(old), Ok(new)) = texts else {
        return binary(old, new, &info.extension);
    };
    if info.tier == Tier::Prose {
        let changes = crate::diff_prose_actions(old, new);
        return TierDiffResult {
            node_count: changes.len(),
            changes,
            fallback: None,
            tier: Tier::Prose,
        };
    }
    let parsed = match info.tier {
        Tier::Code
            if old.len() <= 1_000_000 && new.len() <= 1_000_000 && has_grammar(&info.extension) =>
        {
            (
                parse_code(old, &info.extension, 50_000),
                parse_code(new, &info.extension, 50_000),
            )
        }
        Tier::Data => (
            parse_data_as(old, &info.extension),
            parse_data_as(new, &info.extension),
        ),
        Tier::Markup => (parse_markup(old), parse_markup(new)),
        _ => {
            return raw(old, new, info.tier != Tier::Raw);
        }
    };
    if let (Ok(old), Ok(new)) = parsed {
        let result = diff_trees(
            &old,
            &new,
            MatchOptions {
                max_nodes: 50_000,
                ..MatchOptions::default()
            },
        );
        if result.fallback.is_none() {
            return TierDiffResult {
                changes: result.changes,
                fallback: None,
                node_count: result.node_count,
                tier: info.tier,
            };
        }
    }
    raw(old, new, true)
}
fn whole_file(insert: bool, path: &str, bytes: &[u8]) -> TierDiffResult {
    let mut spec = NodeSpec::new("file");
    spec.label = Some(path.to_owned());
    spec.byte_range = [0, bytes.len()];
    spec.value = Some(if let Ok(text) = std::str::from_utf8(bytes) {
        text.to_owned()
    } else {
        spec.scalar_type = Some("bytes".to_owned());
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
        }
        hex
    });
    let mut builder = differens_core::TreeBuilder::new();
    let info = classify_file(path);
    let binary = info.tier == Tier::Binary
        || (info.tier == Tier::Raw && bytes[..bytes.len().min(8192)].contains(&0));
    if !binary {
        if let Ok(source) = std::str::from_utf8(bytes) {
            builder.set_legacy_source(source);
        }
    }
    let root = builder
        .push(spec)
        .expect("whole-file node has a valid range");
    let node = builder
        .finish(root)
        .expect("whole-file tree contains one root")
        .root_ref();
    let action = if insert {
        EditAction::Insert {
            node,
            parent: single_node(NodeSpec::new("tree")),
            position: 0,
            context: Vec::new(),
        }
    } else {
        EditAction::Delete {
            node,
            context: Vec::new(),
        }
    };
    TierDiffResult {
        changes: vec![action],
        fallback: None,
        node_count: 1,
        tier: classify_file(path).tier,
    }
}
fn binary(old: &[u8], new: &[u8], extension: &str) -> TierDiffResult {
    for plugin in binary_plugins_for(extension) {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| plugin.diff(old, new)));
        if let Ok(Ok(Some(changes))) = result {
            if !changes.is_empty() {
                return TierDiffResult {
                    changes,
                    fallback: None,
                    node_count: 0,
                    tier: Tier::Binary,
                };
            }
        }
    }
    let mut spec = NodeSpec::new("binary_file");
    spec.byte_range = [0, old.len()];
    TierDiffResult {
        changes: vec![EditAction::Update {
            node: single_node(spec),
            detail: UpdateDetail::ValueChanged {
                from: Some(format!("{} bytes", old.len())),
                to: Some(format!("{} bytes", new.len())),
            },
            context: Vec::new(),
        }],
        fallback: None,
        node_count: 0,
        tier: Tier::Binary,
    }
}
fn raw(old: &str, new: &str, fallback: bool) -> TierDiffResult {
    let changes = crate::diff_lines(old, new)
        .into_iter()
        .enumerate()
        .map(|(position, hunk)| hunk_action(hunk, "line", "file", position, Vec::new()))
        .collect::<Vec<_>>();
    TierDiffResult {
        node_count: changes.len(),
        changes,
        fallback: fallback.then(|| "lines".to_owned()),
        tier: Tier::Raw,
    }
}
pub(crate) fn hunk_action(
    hunk: HunkDiff,
    kind: &str,
    parent: &str,
    position: usize,
    context: Vec<differens_core::NodeContext>,
) -> EditAction {
    let mut spec = NodeSpec::new(kind);
    // Hunk nodes have local synthetic ranges, matching legacy UTF-16 widths.
    spec.byte_range = [0, hunk.text.encode_utf16().count()];
    spec.value = Some(hunk.text);
    let node = single_node(spec);
    match hunk.kind {
        HunkKind::Insert => EditAction::Insert {
            node,
            parent: single_node(NodeSpec::new(parent)),
            position,
            context,
        },
        HunkKind::Delete => EditAction::Delete { node, context },
        HunkKind::Update => EditAction::Update {
            node,
            detail: UpdateDetail::ValueChanged {
                from: hunk.old_text,
                to: hunk.new_text,
            },
            context,
        },
    }
}
