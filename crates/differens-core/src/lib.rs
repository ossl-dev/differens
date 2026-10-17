//! Immutable, flat trees and deterministic semantic edit scripts.
//!
//! Build children before their parents with [`TreeBuilder`]. Each finished tree
//! owns its nodes in postorder; deep trees need no recursive allocation or drop.

mod actions;
mod edit_script;
mod hash;
mod matching;
mod tree;

pub use actions::{
    DiffResult, EditAction, Fallback, MatchOptions, NodeContext, SemanticChange, UpdateDetail,
};
pub use hash::hash_text;
#[cfg(feature = "serde")]
pub use tree::FlatSnapshot;
pub use tree::{BuildError, Node, NodeId, NodeRef, NodeSpec, Tree, TreeBuilder, trees_equal};

use std::sync::Arc;

/// Compare two complete trees. Limits apply independently to each input tree.
#[must_use]
pub fn diff_trees(old: &Arc<Tree>, new: &Arc<Tree>, options: MatchOptions) -> DiffResult {
    let node_count = old.len().saturating_add(new.len());
    if old.len() > options.max_nodes || new.len() > options.max_nodes {
        return DiffResult {
            changes: Vec::new(),
            fallback: Some(Fallback::Lines),
            node_count,
        };
    }
    if Arc::ptr_eq(old, new) {
        return DiffResult {
            changes: Vec::new(),
            fallback: None,
            node_count,
        };
    }
    let mut matching = matching::Matching::new(old.len(), new.len());
    matching::top_down(old, new, &mut matching, options.min_height);
    if old.node(old.root()).kind == new.node(new.root()).kind {
        matching.link(old.root().0, new.root().0);
    }
    matching::named_containers(old, new, &mut matching);
    matching::bottom_up(old, new, &mut matching, options.bottom_up_ratio);
    matching::recover_leaves(old, new, &mut matching);
    matching::recover_containers(old, new, &mut matching);
    matching::recover_leaves(old, new, &mut matching);
    DiffResult {
        changes: edit_script::generate(old, new, &matching),
        fallback: None,
        node_count,
    }
}
