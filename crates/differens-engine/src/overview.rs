use std::collections::HashSet;

use differens_core::{EditAction, SemanticChange};
use differens_correlate::CrossFileMatch;
use differens_narrate::{OutputFormat, readable_changes};
use indexmap::IndexMap;

struct FileSummary {
    path: String,
    status: usize,
    changes: Vec<SemanticChange>,
}
struct Area {
    path: String,
    files: Vec<usize>,
    done: bool,
}

fn totals<'a>(files: impl Iterator<Item = &'a FileSummary>) -> String {
    let mut counts = [0usize; 4];
    for file in files {
        counts[file.status] += 1;
    }
    ["added", "removed", "modified", "renamed"]
        .into_iter()
        .zip(counts)
        .filter(|(_, count)| *count > 0)
        .map(|(status, count)| format!("{count} {status}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn areas(files: &[FileSummary]) -> Vec<Area> {
    let mut areas = vec![Area {
        path: String::new(),
        files: (0..files.len()).collect(),
        done: false,
    }];
    while areas.len() < 12 {
        let Some(index) = areas
            .iter()
            .enumerate()
            .filter(|(_, area)| !area.done && area.files.len() > 8)
            .max_by_key(|(_, area)| area.files.len())
            .map(|(index, _)| index)
        else {
            break;
        };
        let area = &areas[index];
        let mut children: IndexMap<String, Vec<usize>> = IndexMap::new();
        for &file in &area.files {
            let relative = &files[file].path[area.path.len()..];
            let path = relative.split_once('/').map_or_else(
                || area.path.clone(),
                |(first, _)| format!("{}{first}/", area.path),
            );
            children.entry(path).or_default().push(file);
        }
        if children.len() == 1 && children.contains_key(&area.path) {
            areas[index].done = true;
            continue;
        }
        let mut groups: Vec<_> = children
            .into_iter()
            .map(|(path, files)| Area {
                path,
                files,
                done: false,
            })
            .collect();
        groups.sort_by_key(|group| std::cmp::Reverse(group.files.len()));
        let capacity = 4.min(12 - areas.len() + 1);
        if groups.len() > capacity {
            let rest = groups.split_off(capacity - 1);
            groups.push(Area {
                path: format!("{}(other)", area.path),
                files: rest.into_iter().flat_map(|area| area.files).collect(),
                done: true,
            });
        }
        areas.splice(index..=index, groups);
    }
    areas.sort_by(|a, b| {
        b.files
            .len()
            .cmp(&a.files.len())
            .then_with(|| a.path.cmp(&b.path))
    });
    areas
}

fn examples(area: &Area, files: &[FileSummary]) -> Vec<String> {
    let mut ranked = Vec::new();
    for &index in &area.files {
        let file = &files[index];
        for change in readable_changes(&file.changes, 20) {
            let declaration = ["added", "removed", "renamed", "modified", "changed"]
                .iter()
                .any(|verb| {
                    ["function", "method", "class"]
                        .iter()
                        .any(|kind| change.description.starts_with(&format!("{verb} {kind} `")))
                });
            let test = file
                .path
                .split(['/', '.', '-'])
                .any(|part| ["test", "spec", "fixtures"].contains(&part));
            let score = if test { 10 } else { 0 }
                + if declaration {
                    0
                } else if change.action.node().kind == "file" {
                    2
                } else {
                    4
                };
            ranked.push((score, &file.path, change.description));
        }
    }
    ranked.sort_by_key(|(score, _, _)| *score);
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter(|(_, path, _)| seen.insert(*path))
        .take(3)
        .map(|(_, path, description)| {
            let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
            let description = if description.chars().count() > 150 {
                description.chars().take(149).chain(['…']).collect()
            } else {
                description
            };
            format!("{path}: {description}")
        })
        .collect()
}

/// Summarize large comparisons with exact counts and bounded examples.
#[must_use]
pub fn overview(
    changes: &[SemanticChange],
    moves: &[CrossFileMatch],
    format: OutputFormat,
) -> Option<String> {
    let mut files: IndexMap<String, FileSummary> = IndexMap::new();
    for change in changes {
        let path = change.file_path.as_deref().unwrap_or("(unknown file)");
        let file = files.entry(path.to_owned()).or_insert_with(|| FileSummary {
            path: path.to_owned(),
            status: 2,
            changes: Vec::new(),
        });
        file.changes.push(change.clone());
        if change.action.node().kind == "file" {
            file.status = match change.action {
                EditAction::Insert { .. } => 0,
                EditAction::Delete { .. } => 1,
                EditAction::Move { .. } => 3,
                EditAction::Update { .. } => file.status,
            };
        }
    }
    for movement in moves {
        for path in [&movement.from_file, &movement.to_file] {
            files.entry(path.clone()).or_insert_with(|| FileSummary {
                path: path.clone(),
                status: 2,
                changes: Vec::new(),
            });
        }
        if movement.node.kind == "file" {
            files.shift_remove(&movement.from_file);
            if let Some(file) = files.get_mut(&movement.to_file) {
                file.status = 3;
            }
        }
    }
    if files.len() <= 20 && readable_changes(changes, 20).len() <= 100 && moves.len() <= 20 {
        return None;
    }
    let files: Vec<_> = files.into_values().collect();
    let mut lines = vec![format!(
        "{} files with logical changes: {}.",
        files.len(),
        totals(files.iter())
    )];
    for area in areas(&files) {
        lines.push(String::new());
        lines.push(format!(
            "{}{} — {}",
            if format == OutputFormat::Markdown {
                "### "
            } else {
                ""
            },
            if area.path.is_empty() {
                "(root)"
            } else {
                &area.path
            },
            totals(area.files.iter().map(|index| &files[*index]))
        ));
        lines.extend(
            examples(&area, &files)
                .into_iter()
                .map(|example| format!("  - {example}")),
        );
    }
    if !moves.is_empty() {
        lines.push(format!("\n{} cross-file moves; examples:", moves.len()));
        let mut ranked: Vec<_> = moves.iter().collect();
        ranked.sort_by_key(|movement| {
            if movement.node.kind == "file" {
                0
            } else if ["Function", "Method", "Class"].contains(&movement.node.kind.as_str()) {
                1
            } else {
                2
            }
        });
        for movement in ranked.into_iter().take(3) {
            lines.push(format!(
                "  - {}: {} → {}{}",
                movement
                    .node
                    .label
                    .as_deref()
                    .unwrap_or(&movement.node.kind),
                movement.from_file,
                movement.to_file,
                if movement.modified {
                    " (also edited)"
                } else {
                    ""
                }
            ));
        }
    }
    lines.push("\nSelected changes shown above. Use --all for every file; --format=ndjson for all underlying actions.".into());
    Some(lines.join("\n"))
}
