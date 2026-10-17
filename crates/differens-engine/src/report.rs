use std::{collections::HashSet, io::Write};

use differens_core::{EditAction, NodeRef, NodeSpec, SemanticChange, TreeBuilder};
use differens_correlate::{
    ActionId, CorrelateOptions, CrossFileMatch, correlate_store, is_move_candidate,
};
use differens_git::FilePair;
use differens_narrate::{OutputFormat, format_changes, humanize_kind, readable_changes, summarize};
use serde::Serialize;

use crate::{DiffEngine, Result, overview};

#[derive(Clone, Copy, Debug, Default)]
pub struct ReportOptions {
    pub all: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveSummary<'a> {
    kind: &'a str,
    name: &'a str,
    from_file: &'a str,
    to_file: &'a str,
    modified: bool,
}

fn move_summaries(moves: &[CrossFileMatch]) -> Vec<MoveSummary<'_>> {
    moves
        .iter()
        .map(|movement| MoveSummary {
            kind: &movement.node.kind,
            name: movement.node.label.as_deref().unwrap_or("unnamed"),
            from_file: &movement.from_file,
            to_file: &movement.to_file,
            modified: movement.modified,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fallback {
    file_path: String,
    fallback: String,
}

#[derive(Serialize)]
struct NdjsonChange<'a> {
    description: &'a str,
    action: &'a EditAction,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NdjsonFile<'a> {
    file_path: &'a str,
    changes: Vec<NdjsonChange<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<&'a str>,
}

fn write_ndjson_file(
    output: &mut impl Write,
    path: &str,
    changes: &[SemanticChange],
    fallback: Option<&str>,
) -> Result<()> {
    serde_json::to_writer(
        &mut *output,
        &NdjsonFile {
            file_path: path,
            changes: changes
                .iter()
                .map(|change| NdjsonChange {
                    description: &change.description,
                    action: &change.action,
                })
                .collect(),
            fallback,
        },
    )?;
    writeln!(output)?;
    output.flush()?;
    Ok(())
}

/// Report a single standalone file comparison. JSON is the legacy change array.
///
/// # Errors
/// Returns an error when building file metadata, encoding JSON, or writing output.
pub fn report_file(
    pair: &FilePair,
    format: OutputFormat,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<()> {
    let result = differens_tiers::diff_with_tier(
        &pair.old_source,
        &pair.new_source,
        &pair.old_path,
        &pair.new_path,
        differens_tiers::SourcePresence {
            old_exists: pair.old_exists,
            new_exists: pair.new_exists,
        },
    );
    let changes = differens_narrate::narrate(&result.changes, Some(&pair.old_path));
    if let Some(fallback) = &result.fallback {
        writeln!(diagnostics, "note: fell back to {fallback} diff")?;
    }
    if format == OutputFormat::Ndjson {
        if !changes.is_empty() {
            write_ndjson_file(output, &pair.old_path, &changes, result.fallback.as_deref())?;
        }
    } else {
        writeln!(output, "{}", format_changes(&changes, format)?)?;
    }
    Ok(())
}

/// Stream repository/directory reports. Machine outputs always remain parseable,
/// including empty comparisons. JSON writes edits as they finish and retains only
/// cross-file candidates; NDJSON flushes each completed file.
///
/// # Errors
/// Returns input, diff, serialization, and writer errors without dropping files.
pub fn report<I>(
    engine: &DiffEngine,
    inputs: I,
    format: OutputFormat,
    empty_message: &str,
    options: ReportOptions,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<()>
where
    I: IntoIterator<Item = differens_git::Result<FilePair>>,
{
    let mut state = ReportState::default();
    if format == OutputFormat::Json {
        output.write_all(b"{\"perFile\":[")?;
    }
    for result in engine.stream(inputs) {
        state.record(result?, format, output)?;
    }
    let moves = state
        .candidates
        .as_ref()
        .map(|store| correlate_store(store, CorrelateOptions::default()))
        .transpose()?
        .unwrap_or_default();
    if state.machine_tail(format, &moves, output)? {
        return Ok(());
    }
    if state.file_count == 0 {
        if format == OutputFormat::Llm {
            writeln!(output, "{}", format_changes(&[], format)?)?;
        } else {
            writeln!(output, "{empty_message}")?;
        }
        return Ok(());
    }
    let relocated: HashSet<_> = moves
        .iter()
        .flat_map(|movement| [movement.deletion, movement.insertion])
        .collect();
    let changes: Vec<_> = state
        .narratives
        .into_iter()
        .filter(|(id, _)| id.is_none_or(|id| !relocated.contains(&id)))
        .map(|(_, change)| change)
        .collect();
    if format == OutputFormat::Llm {
        return write_llm(&changes, &moves, state.source_change_count, output);
    }
    if !state.fallbacks.is_empty() {
        writeln!(
            diagnostics,
            "note: {} file{} used line-diff fallback: {}{}",
            state.fallbacks.len(),
            if state.fallbacks.len() == 1 { "" } else { "s" },
            state
                .fallbacks
                .iter()
                .take(5)
                .map(|fallback| fallback.file_path.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            if state.fallbacks.len() > 5 {
                ", …"
            } else {
                ""
            }
        )?;
    }
    if !options.all {
        if let Some(overview) = overview(&changes, &moves, format) {
            writeln!(output, "{overview}")?;
            return Ok(());
        }
    }
    write_human(&changes, &moves, format, output)
}

#[derive(Default)]
struct ReportState {
    candidates: Option<crate::candidates::CandidateStorage>,
    file_count: usize,
    source_change_count: usize,
    narratives: Vec<(Option<ActionId>, SemanticChange)>,
    fallbacks: Vec<Fallback>,
    json_separator: bool,
}

impl ReportState {
    fn record(
        &mut self,
        result: crate::FileDiff,
        format: OutputFormat,
        output: &mut impl Write,
    ) -> Result<()> {
        let file_index = self.file_count;
        self.file_count += 1;
        self.source_change_count += result.changes.len();
        if let Some(fallback) = &result.fallback {
            self.fallbacks.push(Fallback {
                file_path: result.file_path.clone(),
                fallback: fallback.clone(),
            });
        }
        for (index, change) in result
            .changes
            .iter()
            .filter(|change| is_move_candidate(&change.action))
            .enumerate()
        {
            if self.candidates.is_none() {
                self.candidates = Some(crate::candidates::CandidateStorage::default());
            }
            if let Some(store) = &mut self.candidates {
                store.push(
                    ActionId {
                        file: file_index,
                        action: index,
                    },
                    &result.file_path,
                    &change.action,
                )?;
            }
        }
        match format {
            OutputFormat::Ndjson => {
                if !result.changes.is_empty() {
                    write_ndjson_file(
                        output,
                        &result.file_path,
                        &result.changes,
                        result.fallback.as_deref(),
                    )?;
                }
            }
            OutputFormat::Json => {
                for change in &result.changes {
                    if self.json_separator {
                        output.write_all(b",")?;
                    }
                    serde_json::to_writer(&mut *output, change)?;
                    self.json_separator = true;
                }
            }
            _ => self.collect_narratives(result.changes, file_index, format)?,
        }
        Ok(())
    }

    fn collect_narratives(
        &mut self,
        changes: Vec<SemanticChange>,
        file_index: usize,
        format: OutputFormat,
    ) -> Result<()> {
        let mut action_index = 0;
        let mut other = Vec::new();
        for mut change in changes {
            if is_move_candidate(&change.action) {
                if matches!(format, OutputFormat::Terminal | OutputFormat::Markdown) {
                    if let Some(shown) = readable_changes(std::slice::from_ref(&change), usize::MAX)
                        .into_iter()
                        .next()
                    {
                        change = shown;
                    }
                }
                detach_action(&mut change.action)?;
                self.narratives.push((
                    Some(ActionId {
                        file: file_index,
                        action: action_index,
                    }),
                    change,
                ));
                action_index += 1;
            } else {
                other.push(change);
            }
        }
        if matches!(format, OutputFormat::Terminal | OutputFormat::Markdown) {
            for mut change in readable_changes(&other, usize::MAX) {
                detach_action(&mut change.action)?;
                self.narratives.push((None, change));
            }
        } else {
            let prepared = if format == OutputFormat::Llm {
                differens_narrate::prepare_llm_changes(&other)
            } else {
                other
            };
            for mut change in prepared {
                detach_action(&mut change.action)?;
                self.narratives.push((None, change));
            }
        }
        Ok(())
    }

    fn machine_tail(
        &self,
        format: OutputFormat,
        moves: &[CrossFileMatch],
        output: &mut impl Write,
    ) -> Result<bool> {
        match format {
            OutputFormat::Json => {
                output.write_all(b"]")?;
                if !self.fallbacks.is_empty() {
                    output.write_all(b",\"fallbacks\":")?;
                    serde_json::to_writer(&mut *output, &self.fallbacks)?;
                }
                output.write_all(b",\"crossFileMoves\":")?;
                serde_json::to_writer(&mut *output, &move_summaries(moves))?;
                output.write_all(b"}\n")?;
            }
            OutputFormat::Ndjson => {
                if !moves.is_empty() {
                    serde_json::to_writer(
                        &mut *output,
                        &serde_json::json!({"crossFileMoves":move_summaries(moves)}),
                    )?;
                    writeln!(output)?;
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
}

fn write_llm(
    changes: &[SemanticChange],
    moves: &[CrossFileMatch],
    source_change_count: usize,
    output: &mut impl Write,
) -> Result<()> {
    let files: Vec<_> = moves
        .iter()
        .flat_map(|movement| [movement.from_file.as_str(), movement.to_file.as_str()])
        .collect();
    let context = differens_narrate::LlmReportContext {
        additional_files: &files,
        additional_changes: source_change_count
            .saturating_sub(moves.len())
            .saturating_sub(changes.len()),
        additional_named: moves.len(),
    };
    writeln!(
        output,
        "{}",
        differens_narrate::format_llm_report(changes, context)
    )?;
    if !moves.is_empty() {
        writeln!(output, "# cross-file")?;
        for movement in moves {
            writeln!(
                output,
                "> {} {} -> {}{}",
                movement
                    .node
                    .label
                    .as_deref()
                    .unwrap_or(&movement.node.kind),
                movement.from_file,
                movement.to_file,
                if movement.modified { " edited" } else { "" }
            )?;
        }
    }
    Ok(())
}

fn write_human(
    changes: &[SemanticChange],
    moves: &[CrossFileMatch],
    format: OutputFormat,
    output: &mut impl Write,
) -> Result<()> {
    if !changes.is_empty() || moves.is_empty() {
        writeln!(output, "{}", format_changes(changes, format)?)?;
    }
    if !moves.is_empty() {
        writeln!(output, "\n  cross-file moves:")?;
        for movement in moves {
            if movement.node.kind == "file" {
                writeln!(
                    output,
                    "  → {} file {} to {}",
                    if movement.modified {
                        "renamed and edited"
                    } else {
                        "renamed"
                    },
                    movement.from_file,
                    movement.to_file
                )?;
            } else {
                writeln!(
                    output,
                    "  → {}{} from {} to {}",
                    humanize_kind(&movement.node.kind),
                    movement
                        .node
                        .label
                        .as_ref()
                        .map_or_else(String::new, |name| format!(" `{name}`")),
                    movement.from_file,
                    movement.to_file
                )?;
            }
        }
    }
    let mut summary = Vec::new();
    if !changes.is_empty() {
        summary.push(summarize(changes, true));
    }
    if !moves.is_empty() {
        summary.push(format!(
            "{} cross-file move{}",
            moves.len(),
            if moves.len() == 1 { "" } else { "s" }
        ));
    }
    writeln!(
        output,
        "\n{}",
        if summary.is_empty() {
            "no logical changes".into()
        } else {
            summary.join(", ")
        }
    )?;
    Ok(())
}

// Grouped human facts need metadata only. Rebuilding those nodes releases their
// original complete ASTs instead of keeping one Arc per changed token alive.
fn detached(node: &NodeRef) -> Result<NodeRef> {
    if node.kind != "file" || node.value.is_none() {
        return Ok(node.detached_shallow());
    }
    // Source contents are persisted in the candidate spool before projection;
    // human display of a whole file requires identity and location only.
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new("file");
    spec.label.clone_from(&node.label);
    spec.byte_range = node.byte_range;
    spec.line = node.line;
    let root = builder.push(spec)?;
    Ok(builder.finish(root)?.root_ref())
}

fn detach_action(action: &mut EditAction) -> Result<()> {
    match action {
        EditAction::Insert { node, parent, .. } => {
            *node = detached(node)?;
            *parent = detached(parent)?;
        }
        EditAction::Delete { node, .. } | EditAction::Update { node, .. } => {
            *node = detached(node)?;
        }
        EditAction::Move {
            node,
            from_parent,
            to_parent,
            ..
        } => {
            *node = detached(node)?;
            *from_parent = detached(from_parent)?;
            *to_parent = detached(to_parent)?;
        }
    }
    Ok(())
}
