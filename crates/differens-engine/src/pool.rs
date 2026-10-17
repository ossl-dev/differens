use std::{collections::VecDeque, num::NonZeroUsize};

use differens_core::{EditAction, NodeRef, NodeSpec, SemanticChange, TreeBuilder};
use differens_git::FilePair;
use differens_narrate::narrate;
use differens_tiers::{SourcePresence, diff_with_tier};
use rayon::prelude::*;

use crate::Result;

const WINDOW_FILES: usize = 24;
const WINDOW_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct FileDiff {
    pub changes: Vec<SemanticChange>,
    pub file_path: String,
    pub fallback: Option<String>,
}

/// Diff a file while preserving its display identity and explicit presence.
///
/// # Errors
/// Returns an error if a synthetic file identity cannot be built.
pub fn diff_inline(pair: &FilePair) -> Result<FileDiff> {
    let result = diff_with_tier(
        &pair.old_source,
        &pair.new_source,
        &pair.old_path,
        &pair.new_path,
        SourcePresence {
            old_exists: pair.old_exists,
            new_exists: pair.new_exists,
        },
    );
    let file_path = if pair.new_exists {
        &pair.new_path
    } else {
        &pair.old_path
    }
    .clone();
    let mut changes = narrate(&result.changes, Some(&file_path));
    if pair.old_path != pair.new_path && pair.old_exists && pair.new_exists {
        let node = file_node(&pair.new_path)?;
        let old = file_node(&pair.old_path)?;
        changes.insert(
            0,
            SemanticChange {
                description: format!("renamed file `{}` to `{}`", pair.old_path, pair.new_path),
                file_path: Some(file_path.clone()),
                from_file_path: None,
                to_file_path: None,
                grouped: false,
                action: EditAction::Move {
                    node: node.clone(),
                    from_parent: old,
                    to_parent: node,
                    from_position: 0,
                    to_position: 0,
                    context: Vec::new(),
                },
            },
        );
    }
    for change in &mut changes {
        match &mut change.action {
            EditAction::Update { node, .. } => *node = node.shallow(),
            EditAction::Move {
                node,
                from_parent,
                to_parent,
                ..
            } => {
                *node = node.shallow();
                *from_parent = from_parent.shallow();
                *to_parent = to_parent.shallow();
            }
            EditAction::Insert { parent, .. } => *parent = parent.shallow(),
            EditAction::Delete { .. } => {}
        }
    }
    Ok(FileDiff {
        changes,
        file_path,
        fallback: result.fallback,
    })
}

fn file_node(path: &str) -> Result<NodeRef> {
    let mut builder = TreeBuilder::new();
    let mut spec = NodeSpec::new("file");
    spec.label = Some(path.to_owned());
    let root = builder.push(spec)?;
    Ok(builder.finish(root)?.root_ref())
}

/// Reusable native worker pool. Windowed inputs bound source bytes in flight.
pub struct DiffEngine {
    pool: rayon::ThreadPool,
}

impl DiffEngine {
    /// Build a pool; zero selects up to two workers, leaving one CPU for the host.
    ///
    /// # Errors
    /// Returns an error if native worker threads cannot be started.
    pub fn new(jobs: usize) -> Result<Self> {
        let jobs = if jobs == 0 {
            std::thread::available_parallelism()
                .map_or(1, NonZeroUsize::get)
                .saturating_sub(1)
                .clamp(1, 2)
        } else {
            jobs
        };
        Ok(Self {
            pool: rayon::ThreadPoolBuilder::new()
                .num_threads(jobs)
                .thread_name(|index| format!("differens-{index}"))
                .build()?,
        })
    }

    /// Consume inputs in bounded parallel windows and emit deterministic order.
    pub fn stream<I>(&self, inputs: I) -> DiffStream<'_, I::IntoIter>
    where
        I: IntoIterator<Item = differens_git::Result<FilePair>>,
    {
        DiffStream {
            engine: self,
            inputs: inputs.into_iter(),
            ready: VecDeque::new(),
            ended: false,
        }
    }
}

pub struct DiffStream<'a, I> {
    engine: &'a DiffEngine,
    inputs: I,
    ready: VecDeque<Result<FileDiff>>,
    ended: bool,
}

impl<I: Iterator<Item = differens_git::Result<FilePair>>> Iterator for DiffStream<'_, I> {
    type Item = Result<FileDiff>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(result) = self.ready.pop_front() {
            return Some(result);
        }
        if self.ended {
            return None;
        }
        let mut batch = Vec::with_capacity(WINDOW_FILES);
        let mut bytes = 0usize;
        let mut error = None;
        while batch.len() < WINDOW_FILES && bytes < WINDOW_BYTES {
            match self.inputs.next() {
                Some(Ok(pair)) => {
                    bytes = bytes
                        .saturating_add(pair.old_source.len())
                        .saturating_add(pair.new_source.len());
                    batch.push(pair);
                }
                Some(Err(failure)) => {
                    error = Some(failure.into());
                    self.ended = true;
                    break;
                }
                None => {
                    self.ended = true;
                    break;
                }
            }
        }
        self.ready = self.engine.pool.install(|| {
            batch
                .into_par_iter()
                .map(|pair| diff_inline(&pair))
                .collect()
        });
        if let Some(error) = error {
            self.ready.push_back(Err(error));
        }
        self.ready.pop_front()
    }
}
