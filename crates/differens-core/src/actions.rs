use crate::NodeRef;

/// Nearest ancestor first, including the file wrapper for legacy compatibility.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct NodeContext {
    pub kind: String,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize), serde(tag = "kind"))]
pub enum UpdateDetail {
    Renamed {
        from: String,
        to: String,
    },
    ValueChanged {
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        from: Option<String>,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        to: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize), serde(tag = "type"))]
pub enum EditAction {
    Insert {
        node: NodeRef,
        parent: NodeRef,
        position: usize,
        context: Vec<NodeContext>,
    },
    Delete {
        node: NodeRef,
        context: Vec<NodeContext>,
    },
    Update {
        node: NodeRef,
        detail: UpdateDetail,
        context: Vec<NodeContext>,
    },
    Move {
        node: NodeRef,
        #[cfg_attr(feature = "serde", serde(rename = "fromParent"))]
        from_parent: NodeRef,
        #[cfg_attr(feature = "serde", serde(rename = "toParent"))]
        to_parent: NodeRef,
        #[cfg_attr(feature = "serde", serde(rename = "fromPosition"))]
        from_position: usize,
        #[cfg_attr(feature = "serde", serde(rename = "toPosition"))]
        to_position: usize,
        context: Vec<NodeContext>,
    },
}

impl EditAction {
    #[must_use]
    pub fn node(&self) -> &NodeRef {
        match self {
            Self::Insert { node, .. }
            | Self::Delete { node, .. }
            | Self::Update { node, .. }
            | Self::Move { node, .. } => node,
        }
    }
    #[must_use]
    pub fn context(&self) -> &[NodeContext] {
        match self {
            Self::Insert { context, .. }
            | Self::Delete { context, .. }
            | Self::Update { context, .. }
            | Self::Move { context, .. } => context,
        }
    }
    #[must_use]
    pub fn node_mut(&mut self) -> &mut NodeRef {
        match self {
            Self::Insert { node, .. }
            | Self::Delete { node, .. }
            | Self::Update { node, .. }
            | Self::Move { node, .. } => node,
        }
    }
    #[must_use]
    pub const fn action_type(&self) -> &'static str {
        match self {
            Self::Insert { .. } => "Insert",
            Self::Delete { .. } => "Delete",
            Self::Update { .. } => "Update",
            Self::Move { .. } => "Move",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize),
    serde(rename_all = "camelCase")
)]
pub struct SemanticChange {
    pub action: EditAction,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub file_path: Option<String>,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub from_file_path: Option<String>,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub to_file_path: Option<String>,
    pub description: String,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub grouped: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MatchOptions {
    pub min_height: usize,
    pub bottom_up_ratio: f64,
    pub max_nodes: usize,
}

impl Default for MatchOptions {
    fn default() -> Self {
        Self {
            min_height: 2,
            bottom_up_ratio: 0.5,
            max_nodes: usize::MAX,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize),
    serde(rename_all = "lowercase")
)]
pub enum Fallback {
    Lines,
}

#[derive(Clone, Debug)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize),
    serde(rename_all = "camelCase")
)]
pub struct DiffResult {
    pub changes: Vec<EditAction>,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub fallback: Option<Fallback>,
    pub node_count: usize,
}
