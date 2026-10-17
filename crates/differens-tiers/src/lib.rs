//! File classification, bounded parser adapters, and tiered semantic diffs.
pub mod code;
pub use code::{
    LanguageInfo, ParseCacheStats, clear_parse_cache, has_grammar, list_languages,
    parse_cache_stats, parse_code,
};

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("syntax tree exceeds parse budget")]
    Budget,
    #[error("no grammar for extension")]
    Unsupported,
    #[error("parse cancelled")]
    Cancelled,
    #[error("{0}")]
    Syntax(String),
    #[error(transparent)]
    Build(#[from] differens_core::BuildError),
}
pub mod binary;
pub mod data;
pub mod markup;
mod prose;
mod router;
pub mod sequence;
pub use binary::{
    BinaryDiffPlugin, is_binary_extension, register_binary_plugin, unregister_binary_plugin,
};
pub use data::{parse_data, parse_data_as, tree_from_value};
pub use markup::parse_markup;
pub use prose::diff_prose_actions;
pub use router::{
    FileInfo, Presence, SourcePresence, Tier, TierDiffResult, classify_file, diff_with_tier,
    is_parseable,
};
pub use sequence::{diff_lines, diff_words};

pub(crate) fn single_node(spec: differens_core::NodeSpec) -> differens_core::NodeRef {
    let mut builder = differens_core::TreeBuilder::new();
    let root = builder
        .push(spec)
        .expect("single node specification is valid");
    builder
        .finish(root)
        .expect("single node tree is valid")
        .root_ref()
}
