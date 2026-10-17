//! Ordered parallel semantic diffs, configuration, and streaming reports.

mod candidates;
mod config;
mod overview;
mod pool;
mod report;
mod spill;

pub use config::{DifferensConfig, load_config};
pub use overview::overview;
pub use pool::{DiffEngine, DiffStream, FileDiff, diff_inline};
pub use report::{ReportOptions, report, report_file};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Git(#[from] differens_git::Error),
    #[error(transparent)]
    Tree(#[from] differens_core::BuildError),
    #[error("cannot create diff worker pool: {0}")]
    Pool(#[from] rayon::ThreadPoolBuildError),
    #[error("output failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON output failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("candidate storage failed: {0}")]
    Spill(#[source] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
