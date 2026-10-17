use crate::{
    action_index, declaration, humanize_kind, is_declaration, narrate_action, preview,
    value_previews,
};
use differens_core::{EditAction, NodeContext, SemanticChange, UpdateDetail};
use indexmap::IndexMap;

fn counts(changes: &[SemanticChange]) -> String {
    let mut counts = IndexMap::new();
    for change in changes {
        let word = ["addition", "removal", "update", "move"][action_index(&change.action)];
        *counts.entry(word).or_insert(0usize) += 1;
    }
    counts
        .into_iter()
        .map(|(word, n)| format!("{n} {word}{}", if n == 1 { "" } else { "s" }))
        .collect::<Vec<_>>()
        .join(", ")
}
fn details(changes: &[SemanticChange]) -> String {
    let updates: Vec<_> = changes
        .iter()
        .filter(|c| matches!(c.action, EditAction::Update { .. }))
        .collect();
    if updates.is_empty()
        && changes.len() <= 3
        && changes.iter().all(|c| {
            matches!(
                c.action,
                EditAction::Insert { .. } | EditAction::Delete { .. }
            ) && declaration(c.action.node()).is_some()
        })
    {
        return changes
            .iter()
            .map(|c| {
                let node = declaration(c.action.node()).expect("declaration checked above");
                format!(
                    "{} {} `{}`",
                    if matches!(c.action, EditAction::Insert { .. }) {
                        "added"
                    } else {
                        "removed"
                    },
                    humanize_kind(&node.kind),
                    node.label.as_deref().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    if updates.is_empty() || updates.len() > 3 {
        return counts(changes);
    }
    let mut values = updates
        .iter()
        .map(|change| {
            let (from, to) = match &change.action {
                EditAction::Update {
                    detail: UpdateDetail::Renamed { from, to },
                    ..
                } => (Some(from.as_str()), Some(to.as_str())),
                EditAction::Update {
                    detail: UpdateDetail::ValueChanged { from, to },
                    ..
                } => (from.as_deref(), to.as_deref()),
                _ => unreachable!("updates selected above"),
            };
            let short = |value: Option<&str>| {
                preview(Some(value.unwrap_or("none")), 36).unwrap_or_default()
            };
            let (from, to) = match (from, to) {
                (Some(from), Some(to)) => value_previews(from, to, 36),
                (from, to) => (short(from), short(to)),
            };
            format!("`{from}` → `{to}`")
        })
        .collect::<Vec<_>>();
    if updates.len() < changes.len() {
        values.push(counts(
            &changes
                .iter()
                .filter(|c| !matches!(c.action, EditAction::Update { .. }))
                .cloned()
                .collect::<Vec<_>>(),
        ));
    }
    values.join(", ")
}

/// Group unnamed syntax under declarations without changing machine actions.
#[must_use]
pub fn readable_changes(changes: &[SemanticChange], limit: usize) -> Vec<SemanticChange> {
    let mut files = IndexMap::<Option<&str>, Vec<&SemanticChange>>::new();
    for change in changes {
        files
            .entry(change.file_path.as_deref())
            .or_default()
            .push(change);
    }
    let mut output = Vec::new();
    for group in files.into_values() {
        let mut entries = Vec::new();
        let mut buckets = IndexMap::<GroupKey<'_>, (String, Vec<SemanticChange>)>::new();
        for change in group {
            if change.grouped {
                entries.push(change.clone());
                continue;
            }
            let action = &change.action;
            let node = action.node();
            let (owner, member) = owner_context(action);
            let named = declaration(node).filter(|candidate| {
                !(owner.is_some()
                    && matches!(
                        candidate.kind.as_str(),
                        "Variable" | "TypeDef" | "Interface" | "Enum"
                    ))
            });
            if named.is_some()
                || node.kind == "file"
                || (node.label.is_some()
                    && matches!(
                        node.kind.as_str(),
                        "leaf" | "object" | "array" | "ConfigKey"
                    ))
            {
                let mut shown = change.clone();
                if let Some(named) = named {
                    *shown.action.node_mut() = named;
                }
                if node.kind != "file" {
                    shown.description = narrate_action(&shown.action);
                }
                entries.push(shown);
                continue;
            }
            let subject = owner.map_or_else(
                || {
                    if matches!(node.kind.as_str(), "line" | "word" | "Comment" | "comment") {
                        humanize_kind(&node.kind)
                    } else {
                        "file content".into()
                    }
                },
                |ctx| {
                    format!(
                        "{} `{}`",
                        if member {
                            "property".into()
                        } else {
                            humanize_kind(&ctx.kind)
                        },
                        ctx.label.as_deref().unwrap_or_default()
                    )
                },
            );
            let context: Vec<_> = action
                .context()
                .iter()
                .filter(|ctx| owner.is_none() || (ctx.label.is_some() && is_declaration(&ctx.kind)))
                .map(|ctx| (ctx.kind.as_str(), ctx.label.as_deref()))
                .collect();
            let key = (
                owner.map(|ctx| (ctx.kind.as_str(), ctx.label.as_deref())),
                context,
                subject.clone(),
            );
            buckets
                .entry(key)
                .or_insert_with(|| (subject, Vec::new()))
                .1
                .push(change.clone());
        }
        entries.extend(
            buckets
                .into_values()
                .filter_map(|(subject, edits)| grouped_entry(&subject, &edits)),
        );
        output.extend(entries.iter().take(limit).cloned());
        if entries.len() > limit {
            let rest = &entries[limit..];
            let mut more = rest[0].clone();
            more.description = format!(
                "{} more changes ({}); use --format=json for details",
                rest.len(),
                counts(rest)
            );
            output.push(more);
        }
    }
    output
}

type GroupKey<'a> = (
    Option<(&'a str, Option<&'a str>)>,
    Vec<(&'a str, Option<&'a str>)>,
    String,
);

fn owner_context(action: &EditAction) -> (Option<&NodeContext>, bool) {
    let owner = action
        .context()
        .iter()
        .find(|ctx| ctx.label.is_some() && is_declaration(&ctx.kind));
    // Class-level assignments are members; local assignments retain their
    // function as the readable scope.
    let member = owner
        .filter(|ctx| matches!(ctx.kind.as_str(), "Class" | "Struct" | "Interface"))
        .and_then(|_| {
            action
                .context()
                .iter()
                .take_while(|ctx| !is_declaration(&ctx.kind))
                .find(|ctx| ctx.kind == "Assignment" && ctx.label.is_some())
        });
    (member.or(owner), member.is_some())
}

fn grouped_entry(subject: &str, edits: &[SemanticChange]) -> Option<SemanticChange> {
    let first = edits.first()?;
    let mut entry = first.clone();
    entry.action = EditAction::Update {
        node: entry.action.node().clone(),
        detail: UpdateDetail::ValueChanged {
            from: None,
            to: None,
        },
        context: entry.action.context().to_vec(),
    };
    let verb = if edits.len() == 1 && matches!(first.action, EditAction::Update { .. }) {
        "changed"
    } else {
        "modified"
    };
    entry.description = format!("{verb} {subject} ({})", details(edits));
    entry.grouped = true;
    Some(entry)
}
