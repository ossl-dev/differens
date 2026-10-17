//! Deterministic narration and presentation of semantic edits.
mod readable;

use differens_core::{EditAction, NodeContext, NodeRef, SemanticChange, UpdateDetail};
use indexmap::IndexMap;
pub use readable::readable_changes;
use serde::{Deserialize, Serialize};

/// Stable output formats understood by the native CLI.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    #[default]
    Terminal,
    Json,
    Markdown,
    Llm,
    Ndjson,
}

impl std::str::FromStr for OutputFormat {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "terminal" => Ok(Self::Terminal),
            "json" => Ok(Self::Json),
            "markdown" => Ok(Self::Markdown),
            "llm" => Ok(Self::Llm),
            "ndjson" => Ok(Self::Ndjson),
            _ => Err(format!(
                "unknown format {value:?}; expected terminal, json, markdown, llm, or ndjson"
            )),
        }
    }
}

/// Render a parser concept as human-readable words.
#[must_use]
pub fn humanize_kind(kind: &str) -> String {
    let mut out = String::with_capacity(kind.len());
    let mut previous_lower = false;
    for c in kind.chars() {
        if c == '_' {
            out.push(' ');
        } else {
            if c.is_ascii_uppercase() && previous_lower {
                out.push(' ');
            }
            out.extend(c.to_lowercase());
        }
        previous_lower = c.is_ascii_lowercase();
    }
    out
}

pub(crate) fn preview(value: Option<&str>, max: usize) -> Option<String> {
    let text = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() > max {
        Some(
            text.chars()
                .take(max.saturating_sub(1))
                .chain(['…'])
                .collect(),
        )
    } else {
        Some(text)
    }
}

fn scope(action: &EditAction) -> Option<&NodeContext> {
    action.context().iter().find(|ctx| {
        ctx.label
            .as_deref()
            .is_some_and(|s| !s.is_empty() && s != "unnamed")
    })
}

/// Describe one edit without hiding its containing scope.
#[must_use]
pub fn narrate_action(action: &EditAction) -> String {
    let node = action.node();
    let kind = humanize_kind(&node.kind);
    let name = preview(node.label.as_deref(), 100).or_else(|| preview(node.value.as_deref(), 40));
    let what = name.map_or_else(|| kind.clone(), |name| format!("{kind} `{name}`"));
    let context = scope(action);
    let phrase = context.map_or_else(String::new, |ctx| {
        format!(
            " in {} `{}`",
            humanize_kind(&ctx.kind),
            ctx.label.as_deref().unwrap_or_default()
        )
    });
    match action {
        EditAction::Insert { .. } => format!("added {what}{phrase}"),
        EditAction::Delete { .. } => context.map_or_else(
            || format!("removed {what}"),
            |ctx| {
                format!(
                    "removed {what} from {} `{}`",
                    humanize_kind(&ctx.kind),
                    ctx.label.as_deref().unwrap_or_default()
                )
            },
        ),
        EditAction::Update {
            detail: UpdateDetail::Renamed { from, to },
            ..
        } => format!("renamed {kind} `{from}` to `{to}`{phrase}"),
        EditAction::Update {
            detail: UpdateDetail::ValueChanged { from, to },
            ..
        } => {
            let target = node.label.as_ref().map_or_else(
                || kind.clone(),
                |label| format!("value of {kind} `{label}`"),
            );
            match (from, to) {
                (Some(from), Some(to)) => format!(
                    "changed {target} from `{}` to `{}`{phrase}",
                    preview(Some(from), 40).unwrap_or_default(),
                    preview(Some(to), 40).unwrap_or_default()
                ),
                (Some(_), None) => format!("removed {target}{phrase}"),
                (None, Some(to)) => format!(
                    "set {target} to `{}`{phrase}",
                    preview(Some(to), 40).unwrap_or_default()
                ),
                _ => format!("modified {what}{phrase}"),
            }
        }
        EditAction::Move {
            from_parent,
            to_parent,
            to_position,
            ..
        } => match (&from_parent.label, &to_parent.label) {
            (Some(from), Some(to)) => format!("moved {what} from {from} to {to}"),
            _ => format!("moved {what} to position {}{phrase}", to_position + 1),
        },
    }
}

/// Narrate edits and suppress only a renamed declaration's own name token.
#[must_use]
pub fn narrate(actions: &[EditAction], file_path: Option<&str>) -> Vec<SemanticChange> {
    let renames: Vec<_> = actions
        .iter()
        .filter_map(|action| match action {
            EditAction::Update {
                node,
                detail: UpdateDetail::Renamed { from, to },
                ..
            } if node.label.is_some() => Some((node, from, to)),
            _ => None,
        })
        .collect();
    actions
        .iter()
        .filter(|action| {
            if let EditAction::Update {
                node,
                detail:
                    UpdateDetail::ValueChanged {
                        from: Some(from),
                        to: Some(to),
                    },
                ..
            } = action
            {
                if node.label.is_none() && node.kind == "identifier" {
                    return !renames.iter().any(|(decl, old, new)| {
                        if *old != from || *new != to {
                            return false;
                        }
                        let name = decl
                            .children()
                            .find(|child| child.kind == "identifier" && child.value == decl.label);
                        let range = name
                            .map(|name| name.byte_range)
                            .or_else(|| decl.children.is_empty().then_some(decl.byte_range));
                        range == Some(node.byte_range)
                    });
                }
            }
            true
        })
        .map(|action| SemanticChange {
            action: action.clone(),
            file_path: file_path.map(str::to_owned),
            from_file_path: None,
            to_file_path: None,
            description: narrate_action(action),
            grouped: false,
        })
        .collect()
}

/// Summarize raw or presentation-grouped edits.
#[must_use]
pub fn summarize(changes: &[SemanticChange], compact: bool) -> String {
    let grouped;
    let changes = if compact {
        grouped = readable_changes(changes, usize::MAX);
        &grouped[..]
    } else {
        changes
    };
    let mut counts = [0usize; 4];
    for change in changes {
        counts[action_index(&change.action)] += 1;
    }
    let parts: Vec<_> = ["addition", "deletion", "modification", "move"]
        .into_iter()
        .zip(counts)
        .filter(|(_, n)| *n > 0)
        .map(|(word, n)| format!("{n} {word}{}", if n == 1 { "" } else { "s" }))
        .collect();
    if parts.is_empty() {
        "no logical changes".into()
    } else {
        parts.join(", ")
    }
}

pub(crate) const fn action_index(action: &EditAction) -> usize {
    match action {
        EditAction::Insert { .. } => 0,
        EditAction::Delete { .. } => 1,
        EditAction::Update { .. } => 2,
        EditAction::Move { .. } => 3,
    }
}

fn groups(changes: &[SemanticChange]) -> IndexMap<Option<&str>, Vec<SemanticChange>> {
    let mut groups = IndexMap::new();
    for change in changes {
        groups
            .entry(change.file_path.as_deref())
            .or_insert_with(Vec::new)
            .push(change.clone());
    }
    groups
}

/// Format semantic changes. Repository envelopes and NDJSON framing belong to the engine.
///
/// # Errors
/// Returns a serializer error if an edit cannot be represented as JSON.
pub fn format_changes(
    changes: &[SemanticChange],
    format: OutputFormat,
) -> Result<String, serde_json::Error> {
    if format == OutputFormat::Json {
        return serde_json::to_string_pretty(changes);
    }
    if format == OutputFormat::Llm {
        return Ok(format_llm(changes));
    }
    if format == OutputFormat::Ndjson {
        return changes
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map(|lines| lines.join("\n"));
    }
    if changes.is_empty() {
        return Ok(if format == OutputFormat::Markdown {
            "_no logical changes_"
        } else {
            "no logical changes"
        }
        .into());
    }
    let presented = readable_changes(changes, 20);
    let groups = groups(&presented);
    let multiple = groups.len() > 1;
    Ok(groups
        .into_iter()
        .map(|(path, group)| {
            let body = group
                .iter()
                .map(|change| {
                    if format == OutputFormat::Markdown {
                        format!("- {}", change.description)
                    } else {
                        format!("  {} {}", icon(&change.action), change.description)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            if format == OutputFormat::Markdown {
                format!("## {}\n\n{body}", path.unwrap_or("Changes"))
            } else if multiple {
                format!("{}\n{body}", path.unwrap_or("(unknown file)"))
            } else {
                body
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

const fn icon(action: &EditAction) -> &'static str {
    match action {
        EditAction::Insert { .. } => "+",
        EditAction::Delete { .. } => "-",
        EditAction::Update { .. } => "~",
        EditAction::Move { .. } => "→",
    }
}
const fn llm_op(action: &EditAction) -> &'static str {
    match action {
        EditAction::Move { .. } => ">",
        _ => icon(action),
    }
}
fn minor(action: &EditAction) -> bool {
    matches!(
        action.node().kind.as_str(),
        "line" | "word" | "Comment" | "comment"
    ) || (!matches!(action, EditAction::Update { .. }) && action.node().label.is_none())
}
fn llm_value(value: Option<&str>) -> String {
    value.map_or_else(
        || "none".into(),
        |v| preview(Some(v), 60).unwrap_or_else(|| "\"\"".into()),
    )
}
fn llm_line(action: &EditAction) -> String {
    let node = action.node();
    let kind = humanize_kind(&node.kind);
    let name = if node.kind == "file" {
        ""
    } else {
        node.label.as_deref().unwrap_or_default()
    };
    let at = node.line.map_or_else(String::new, |n| format!(" :{n}"));
    let within = scope(action)
        .filter(|ctx| ctx.label.as_deref() != Some(name))
        .map_or_else(String::new, |ctx| {
            format!(
                " < {} {}",
                humanize_kind(&ctx.kind),
                ctx.label.as_deref().unwrap_or_default()
            )
        });
    let head = format!(
        "{} {kind}{}{at}{within}",
        llm_op(action),
        if name.is_empty() {
            String::new()
        } else {
            format!(" {name}")
        }
    );
    match action {
        EditAction::Update {
            detail: UpdateDetail::Renamed { from, to },
            ..
        } => format!("{head} {from} -> {to}"),
        EditAction::Update {
            detail: UpdateDetail::ValueChanged { from, to },
            ..
        } => format!(
            "{head} {} -> {}",
            llm_value(from.as_deref()),
            llm_value(to.as_deref())
        ),
        EditAction::Move { from_parent, .. } => format!(
            "{head} from {}",
            from_parent.label.as_ref().unwrap_or(&from_parent.kind)
        ),
        _ => head,
    }
}
fn format_llm(changes: &[SemanticChange]) -> String {
    let groups = groups(changes);
    let named = groups
        .values()
        .map(|group| {
            readable_changes(
                &group
                    .iter()
                    .filter(|c| !minor(&c.action))
                    .cloned()
                    .collect::<Vec<_>>(),
                20,
            )
            .len()
        })
        .sum::<usize>();
    let mut lines = vec![format!(
        "differens/1 {} files {} changes {named} named",
        groups.len(),
        changes.len()
    )];
    for (path, group) in groups {
        lines.push(format!("# {}", path.unwrap_or("(unknown)")));
        let mut counts = IndexMap::<String, usize>::new();
        for change in &group {
            if minor(&change.action) {
                *counts
                    .entry(humanize_kind(&change.action.node().kind))
                    .or_default() += 1;
            }
        }
        let major: Vec<_> = group.into_iter().filter(|c| !minor(&c.action)).collect();
        for change in readable_changes(&major, 20) {
            if change.description != narrate_action(&change.action)
                && change.action.node().kind != "file"
            {
                let at = change
                    .action
                    .node()
                    .line
                    .map_or_else(String::new, |n| format!(" :{n}"));
                lines.push(format!(
                    "{} {}{at}",
                    llm_op(&change.action),
                    change.description.replace('`', "")
                ));
            } else {
                lines.push(llm_line(&change.action));
            }
        }
        if !counts.is_empty() {
            lines.push(format!(
                "* {}",
                counts
                    .into_iter()
                    .map(|(kind, n)| format!("{n} {kind}{}", if n == 1 { "" } else { "s" }))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    lines.join("\n")
}

pub(crate) fn declaration(node: &NodeRef) -> Option<NodeRef> {
    let mut stack = vec![node.clone()];
    while let Some(node) = stack.pop() {
        if is_declaration(&node.kind) && node.label.is_some() {
            return Some(node);
        }
        if node.kind == "Export" {
            let children: Vec<_> = node.children().collect();
            stack.extend(children.into_iter().rev());
        }
    }
    None
}
pub(crate) fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "Function"
            | "Method"
            | "Class"
            | "Interface"
            | "TypeDef"
            | "Enum"
            | "Variable"
            | "Struct"
            | "Trait"
            | "Module"
            | "PropertySignature"
            | "MethodSignature"
    )
}
