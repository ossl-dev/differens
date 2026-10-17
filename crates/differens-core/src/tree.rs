use std::{collections::BTreeMap, ops::Deref, sync::Arc};

use crate::hash::Hasher;

/// A postorder index, meaningful only within its owning [`Tree`].
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize, serde::Deserialize),
    serde(transparent)
)]
pub struct NodeId(pub usize);

/// Input to [`TreeBuilder::push`]. Children must already exist in source order.
#[derive(Clone, Debug)]
pub struct NodeSpec {
    pub kind: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub scalar_type: Option<String>,
    /// Optional scoped identity for same-named containers (for example a Go
    /// method's receiver type). This is a matching hint, not serialized content.
    pub match_key: Option<String>,
    pub children: Vec<NodeId>,
    pub byte_range: [usize; 2],
    pub line: Option<usize>,
    pub match_by_kind: bool,
    /// Preserve an explicitly supplied `false` in legacy JSON metadata.
    pub emit_match_by_kind: bool,
}

impl NodeSpec {
    #[must_use]
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            label: None,
            value: None,
            scalar_type: None,
            match_key: None,
            children: Vec::new(),
            byte_range: [0, 0],
            line: None,
            match_by_kind: false,
            emit_match_by_kind: false,
        }
    }
}

/// Immutable node metadata. Child references are indices, never recursive owners.
#[derive(Clone, Debug)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize, serde::Deserialize),
    serde(rename_all = "camelCase")
)]
pub struct Node {
    pub kind: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub scalar_type: Option<String>,
    pub children: Vec<NodeId>,
    pub byte_range: [usize; 2],
    pub line: Option<usize>,
    pub match_by_kind: bool,
    pub emit_match_by_kind: bool,
    pub height: usize,
    pub content_hash: u64,
    pub structure_hash: u64,
    pub parent: Option<NodeId>,
    pub position: usize,
    pub size: usize,
}

impl Node {
    pub(crate) fn content_equal(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.label == other.label
            && self.value == other.value
            && self.scalar_type == other.scalar_type
            && self.children.len() == other.children.len()
    }
}

/// One complete validated tree, stored in source-order postorder.
#[derive(Clone, Debug)]
pub struct Tree {
    pub(crate) nodes: Vec<Node>,
    legacy_offsets: Option<Arc<[(usize, usize)]>>,
    match_keys: BTreeMap<NodeId, String>,
}

impl Tree {
    pub(crate) fn has_match_keys(&self) -> bool {
        !self.match_keys.is_empty()
    }

    #[must_use]
    pub fn root(&self) -> NodeId {
        NodeId(self.nodes.len() - 1)
    }
    /// Access a node using an ID belonging to this tree.
    ///
    /// # Panics
    /// Panics if the index is outside this tree.
    #[must_use]
    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.0]
    }
    #[must_use]
    pub fn get(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id.0)
    }
    #[must_use]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
    #[must_use]
    pub fn root_ref(self: &Arc<Self>) -> NodeRef {
        NodeRef::new(Arc::clone(self), self.root())
    }
    /// Map UTF-8 byte boundaries to legacy UTF-16 code-unit boundaries when the
    /// producing adapter supplied its source. Unmapped trees retain byte spans.
    /// Detached projections retain mappings for their node boundaries only.
    #[must_use]
    pub fn legacy_range(&self, byte_range: [usize; 2]) -> [usize; 2] {
        let Some(offsets) = self.legacy_offsets.as_deref() else {
            return byte_range;
        };
        byte_range.map(|byte| {
            let index = offsets.partition_point(|&(end, _)| end <= byte);
            byte - index.checked_sub(1).map_or(0, |index| offsets[index].1)
        })
    }
    /// Optional adapter identity, separate from content, hashes, and JSON.
    #[must_use]
    pub fn match_key(&self, id: NodeId) -> Option<&str> {
        self.match_keys.get(&id).map(String::as_str)
    }
    /// Conservative retained bytes for shared offset maps and sparse identities.
    /// Counting this per detached candidate can overcount shared map ownership,
    /// which is preferable when enforcing a retained-memory budget.
    #[must_use]
    pub fn auxiliary_heap_bytes(&self) -> usize {
        let offsets = self.legacy_offsets.as_ref().map_or(0, |offsets| {
            offsets
                .len()
                .saturating_mul(std::mem::size_of::<(usize, usize)>())
                .saturating_add(64)
        });
        self.match_keys.values().fold(offsets, |bytes, key| {
            // Budget a complete B-tree node per key, including sparse occupancy
            // and allocator overhead, rather than relying on average fill.
            bytes
                .saturating_add(key.capacity())
                .saturating_add(16 * std::mem::size_of::<(NodeId, String)>() + 64)
        })
    }
    fn projected_offsets(&self, nodes: &[Node]) -> Option<Arc<[(usize, usize)]>> {
        let source = self.legacy_offsets.as_deref()?;
        let mut boundaries = Vec::with_capacity(nodes.len() * 2);
        for node in nodes {
            boundaries.extend(node.byte_range);
        }
        boundaries.sort_unstable();
        boundaries.dedup();
        let mut projected = Vec::new();
        let mut previous_difference = 0;
        for byte in boundaries {
            let index = source.partition_point(|&(end, _)| end <= byte);
            let difference = index.checked_sub(1).map_or(0, |index| source[index].1);
            if difference != previous_difference {
                projected.push((byte, difference));
                previous_difference = difference;
            }
        }
        if projected.is_empty() {
            None
        } else if projected.as_slice() == source {
            self.legacy_offsets.clone()
        } else {
            Some(projected.into())
        }
    }
    pub(crate) fn lo(&self, id: usize) -> usize {
        id + 1 - self.nodes[id].size
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum BuildError {
    #[error("child index {0} does not precede its parent")]
    InvalidChild(usize),
    #[error("child {0} already has a parent")]
    SharedChild(usize),
    #[error("children must occupy contiguous postorder ranges in source order")]
    NonContiguousChildren,
    #[error("byte range ends before it starts")]
    InvalidRange,
    #[error("source lines are one-based")]
    InvalidLine,
    #[error("root must contain every node in the builder")]
    InvalidRoot,
    #[error("tree size exceeds addressable storage")]
    SizeOverflow,
    #[error("snapshot metadata disagrees with its validated topology or fingerprints")]
    InvalidSnapshot,
}

/// Validates topology as it builds a forest, then freezes one complete tree.
#[derive(Debug, Default)]
pub struct TreeBuilder {
    nodes: Vec<Node>,
    legacy_offsets: Option<Arc<[(usize, usize)]>>,
    match_keys: BTreeMap<NodeId, String>,
}

impl TreeBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    #[must_use]
    pub fn with_capacity(nodes: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(nodes),
            legacy_offsets: None,
            match_keys: BTreeMap::new(),
        }
    }

    /// Construct a builder whose JSON spans preserve legacy UTF-16 coordinates.
    /// The source is scanned once; ASCII needs no mapping allocation.
    #[must_use]
    pub fn with_source(source: &str) -> Self {
        let mut builder = Self::new();
        builder.set_legacy_source(source);
        builder
    }

    /// Attach the adapter's source without retaining its text. Internal node
    /// spans remain UTF-8 bytes. Only non-ASCII character ends need map entries.
    pub fn set_legacy_source(&mut self, source: &str) {
        self.legacy_offsets = if source.is_ascii() {
            None
        } else {
            let mut difference = 0;
            Some(
                source
                    .char_indices()
                    .filter_map(|(start, character)| {
                        if character.is_ascii() {
                            return None;
                        }
                        difference += character.len_utf8() - character.len_utf16();
                        Some((start + character.len_utf8(), difference))
                    })
                    .collect(),
            )
        };
    }

    /// Append a parent after its contiguous child subtrees. Failed calls do not
    /// mutate the builder, so callers may correct a malformed specification.
    ///
    /// # Errors
    /// Rejects invalid ranges, zero source lines, missing/shared children, and
    /// child order that violates contiguous postorder storage.
    pub fn push(&mut self, spec: NodeSpec) -> Result<NodeId, BuildError> {
        if spec.byte_range[0] > spec.byte_range[1] {
            return Err(BuildError::InvalidRange);
        }
        if spec.line == Some(0) {
            return Err(BuildError::InvalidLine);
        }
        let id = NodeId(self.nodes.len());
        let mut height = 1;
        let mut size = 1_usize;
        let mut next = spec
            .children
            .first()
            .map(|child| {
                self.nodes
                    .get(child.0)
                    .map(|n| child.0 + 1 - n.size)
                    .ok_or(BuildError::InvalidChild(child.0))
            })
            .transpose()?
            .unwrap_or(id.0);
        let mut content = Hasher::new(&spec.kind);
        let mut structure = Hasher::new(&spec.kind);
        if let Some(label) = &spec.label {
            content.text(label);
        }
        if let Some(value) = &spec.value {
            content.text(value);
        }
        // Preserve every legacy hash when no type metadata is present.
        if let Some(scalar_type) = &spec.scalar_type {
            content.text("\0scalar:");
            content.text(scalar_type);
        }
        for child in &spec.children {
            let node = self
                .nodes
                .get(child.0)
                .ok_or(BuildError::InvalidChild(child.0))?;
            if node.parent.is_some() {
                return Err(BuildError::SharedChild(child.0));
            }
            if child.0 + 1 - node.size != next {
                return Err(BuildError::NonContiguousChildren);
            }
            next = child.0 + 1;
            size = size
                .checked_add(node.size)
                .ok_or(BuildError::SizeOverflow)?;
            height = height.max(node.height.checked_add(1).ok_or(BuildError::SizeOverflow)?);
            content.child(node.content_hash);
            structure.child(node.structure_hash);
        }
        if next != id.0 {
            return Err(BuildError::NonContiguousChildren);
        }
        for (position, child) in spec.children.iter().enumerate() {
            self.nodes[child.0].parent = Some(id);
            self.nodes[child.0].position = position;
        }
        self.nodes.push(Node {
            kind: spec.kind,
            label: spec.label,
            value: spec.value,
            scalar_type: spec.scalar_type,
            children: spec.children,
            byte_range: spec.byte_range,
            line: spec.line,
            match_by_kind: spec.match_by_kind,
            emit_match_by_kind: spec.emit_match_by_kind,
            height,
            content_hash: content.finish(),
            structure_hash: structure.finish(),
            parent: None,
            position: 0,
            size,
        });
        if let Some(key) = spec.match_key {
            self.match_keys.insert(id, key);
        }
        Ok(id)
    }

    /// # Errors
    /// Rejects empty builders, non-root IDs, and disconnected forests.
    pub fn finish(self, root: NodeId) -> Result<Arc<Tree>, BuildError> {
        if self
            .nodes
            .get(root.0)
            .is_none_or(|node| root.0 + 1 != self.nodes.len() || node.size != self.nodes.len())
        {
            return Err(BuildError::InvalidRoot);
        }
        Ok(Arc::new(Tree {
            nodes: self.nodes,
            legacy_offsets: self.legacy_offsets,
            match_keys: self.match_keys,
        }))
    }
}

/// Owned reference to a node. Ownership is shared once per tree, never per node.
#[derive(Clone, Debug)]
pub struct NodeRef {
    pub tree: Arc<Tree>,
    pub id: NodeId,
    shallow: bool,
}

impl NodeRef {
    /// # Panics
    /// Panics if `id` is outside `tree`.
    #[must_use]
    pub fn new(tree: Arc<Tree>, id: NodeId) -> Self {
        assert!(tree.get(id).is_some(), "node ID belongs to tree");
        Self {
            tree,
            id,
            shallow: false,
        }
    }
    /// Project serialization to metadata and an empty `children` array.
    #[must_use]
    pub fn shallow(&self) -> Self {
        Self {
            shallow: true,
            ..self.clone()
        }
    }
    /// Whether JSON serialization omits the referenced node's descendants.
    #[must_use]
    pub fn is_shallow(&self) -> bool {
        self.shallow
    }
    /// Adapter identity used to disambiguate same-labeled containers.
    #[must_use]
    pub fn match_key(&self) -> Option<&str> {
        self.tree.match_key(self.id)
    }
    /// Copy this subtree into an independent arena, releasing unrelated nodes.
    /// Shallow references copy only their projected node.
    #[must_use]
    pub fn detached(&self) -> Self {
        if self.shallow {
            return self.detached_shallow();
        }
        let start = self.tree.lo(self.id.0);
        let legacy_offsets = self
            .tree
            .projected_offsets(&self.tree.nodes[start..=self.id.0]);
        if start == 0
            && self.id == self.tree.root()
            && legacy_offsets.as_deref() == self.tree.legacy_offsets.as_deref()
        {
            return self.clone();
        }
        let mut nodes = self.tree.nodes[start..=self.id.0].to_vec();
        let root = NodeId(nodes.len() - 1);
        for node in &mut nodes {
            for child in &mut node.children {
                child.0 -= start;
            }
            node.parent = node
                .parent
                .filter(|parent| parent.0 <= self.id.0)
                .map(|parent| NodeId(parent.0 - start));
        }
        nodes[root.0].parent = None;
        nodes[root.0].position = 0;
        Self::new(
            Arc::new(Tree {
                nodes,
                legacy_offsets,
                match_keys: self
                    .tree
                    .match_keys
                    .range(NodeId(start)..=self.id)
                    .map(|(id, key)| (NodeId(id.0 - start), key.clone()))
                    .collect(),
            }),
            root,
        )
    }
    /// Copy one serialization projection, preserving its original height/hashes.
    /// This intentionally omits descendants and is for reporting, not matching
    /// against the original full subtree.
    #[must_use]
    pub fn detached_shallow(&self) -> Self {
        let node = Node {
            kind: self.kind.clone(),
            label: self.label.clone(),
            value: self.value.clone(),
            scalar_type: self.scalar_type.clone(),
            children: Vec::new(),
            byte_range: self.byte_range,
            line: self.line,
            match_by_kind: self.match_by_kind,
            emit_match_by_kind: self.emit_match_by_kind,
            height: self.height,
            content_hash: self.content_hash,
            structure_hash: self.structure_hash,
            parent: None,
            position: 0,
            size: 1,
        };
        let legacy_offsets = self.tree.projected_offsets(std::slice::from_ref(&node));
        Self {
            tree: Arc::new(Tree {
                nodes: vec![node],
                legacy_offsets,
                match_keys: self
                    .match_key()
                    .map(|key| (NodeId(0), key.to_owned()))
                    .into_iter()
                    .collect(),
            }),
            id: NodeId(0),
            shallow: true,
        }
    }
    pub fn children(&self) -> impl ExactSizeIterator<Item = Self> + '_ {
        self.deref()
            .children
            .iter()
            .map(|id| Self::new(Arc::clone(&self.tree), *id))
    }
    #[must_use]
    pub fn parent(&self) -> Option<Self> {
        self.deref()
            .parent
            .map(|id| Self::new(Arc::clone(&self.tree), id))
    }
}

/// Flat spill/storage representation. Restoring validates tree topology and
/// fingerprints; serialized children are IDs, so encoding and drop stay flat.
#[cfg(feature = "serde")]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FlatSnapshot {
    nodes: Vec<Node>,
    root: NodeId,
    shallow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_offsets: Option<Arc<[(usize, usize)]>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    match_keys: BTreeMap<NodeId, String>,
}

#[cfg(feature = "serde")]
impl NodeRef {
    #[must_use]
    pub fn snapshot(&self) -> FlatSnapshot {
        let detached = self.detached();
        let tree = Arc::unwrap_or_clone(detached.tree);
        FlatSnapshot {
            legacy_offsets: tree.legacy_offsets,
            match_keys: tree.match_keys,
            nodes: tree.nodes,
            root: detached.id,
            shallow: detached.shallow,
        }
    }
}

#[cfg(feature = "serde")]
impl FlatSnapshot {
    /// Restore an independent node owner from validated flat storage.
    ///
    /// # Errors
    /// Rejects invalid/shared/disconnected topology, ranges, source lines,
    /// or inconsistent parent, height, size, position, or fingerprint metadata.
    /// Shallow projections validate their single-node shape and hash width;
    /// their original descendants are intentionally unavailable.
    pub fn into_node_ref(self) -> Result<NodeRef, BuildError> {
        if self.nodes.is_empty() || self.root.0 != self.nodes.len() - 1 {
            return Err(BuildError::InvalidRoot);
        }
        if self.match_keys.keys().any(|id| id.0 >= self.nodes.len()) {
            return Err(BuildError::InvalidSnapshot);
        }
        if let Some(offsets) = self.legacy_offsets.as_deref() {
            let mut previous = (0, 0);
            for &(byte, difference) in offsets {
                if byte <= previous.0
                    || difference <= previous.1
                    || difference > byte
                    || byte - previous.0 < difference - previous.1 + 1
                {
                    return Err(BuildError::InvalidSnapshot);
                }
                previous = (byte, difference);
            }
        }
        let mut builder = TreeBuilder::with_capacity(self.nodes.len());
        for (index, node) in self.nodes.iter().enumerate() {
            builder.push(NodeSpec {
                kind: node.kind.clone(),
                label: node.label.clone(),
                value: node.value.clone(),
                scalar_type: node.scalar_type.clone(),
                match_key: self.match_keys.get(&NodeId(index)).cloned(),
                children: node.children.clone(),
                byte_range: node.byte_range,
                line: node.line,
                match_by_kind: node.match_by_kind,
                emit_match_by_kind: node.emit_match_by_kind,
            })?;
        }
        let built = builder.finish(self.root)?;
        if self.shallow {
            let node = &self.nodes[0];
            if self.nodes.len() != 1
                || node.parent.is_some()
                || node.position != 0
                || node.size != 1
                || node.height == 0
                || node.content_hash >= (1_u64 << 53)
                || node.structure_hash >= (1_u64 << 53)
            {
                return Err(BuildError::InvalidSnapshot);
            }
        } else if self.nodes.iter().zip(&built.nodes).any(|(stored, actual)| {
            stored.parent != actual.parent
                || stored.position != actual.position
                || stored.size != actual.size
                || stored.height != actual.height
                || stored.content_hash != actual.content_hash
                || stored.structure_hash != actual.structure_hash
        }) {
            return Err(BuildError::InvalidSnapshot);
        }
        Ok(NodeRef {
            tree: Arc::new(Tree {
                nodes: self.nodes,
                legacy_offsets: self.legacy_offsets,
                match_keys: self.match_keys,
            }),
            id: self.root,
            shallow: self.shallow,
        })
    }
}

impl Deref for NodeRef {
    type Target = Node;
    fn deref(&self) -> &Self::Target {
        self.tree.node(self.id)
    }
}

impl PartialEq for NodeRef {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && Arc::ptr_eq(&self.tree, &other.tree)
    }
}
impl Eq for NodeRef {}

/// Exact content and topology comparison, independent of fingerprints and spans.
#[must_use]
pub fn trees_equal(a: &NodeRef, b: &NodeRef) -> bool {
    subtrees_equal(&a.tree, a.id.0, &b.tree, b.id.0, false)
}

pub(crate) fn subtrees_equal(a: &Tree, i: usize, b: &Tree, j: usize, structure_only: bool) -> bool {
    if a.nodes[i].size != b.nodes[j].size {
        return false;
    }
    let range_a = &a.nodes[a.lo(i)..=i];
    let range_b = &b.nodes[b.lo(j)..=j];
    range_a.iter().zip(range_b).all(|(left, right)| {
        left.size == right.size
            && if structure_only {
                left.kind == right.kind && left.children.len() == right.children.len()
            } else {
                left.content_equal(right)
            }
    })
}

#[cfg(feature = "serde")]
impl serde::Serialize for NodeRef {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Emit the legacy nested JSON shape using an explicit stack. A recursive
        // Serialize implementation would overflow on adversarial deep inputs.
        let json = self.to_json().map_err(serde::ser::Error::custom)?;
        let raw =
            serde_json::value::RawValue::from_string(json).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}

#[cfg(feature = "serde")]
impl NodeRef {
    /// Serialize the legacy nested node shape without recursive traversal.
    ///
    /// # Errors
    /// Returns a JSON encoding error if metadata cannot be serialized.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        use std::io::Write;
        enum Event {
            Node(NodeId),
            Close,
        }
        let mut output = Vec::new();
        let mut stack = vec![Event::Node(self.id)];
        while let Some(event) = stack.pop() {
            match event {
                Event::Close => output.extend_from_slice(b"]}"),
                Event::Node(id) => {
                    let node = self.tree.node(id);
                    if output.last() == Some(&b'}') {
                        output.push(b',');
                    }
                    output.extend_from_slice(b"{\"kind\":");
                    serde_json::to_writer(&mut output, &node.kind)?;
                    for (key, value) in [
                        ("label", &node.label),
                        ("value", &node.value),
                        ("scalarType", &node.scalar_type),
                    ] {
                        if let Some(value) = value {
                            write!(&mut output, ",\"{key}\":").expect("writing to Vec cannot fail");
                            serde_json::to_writer(&mut output, value)?;
                        }
                    }
                    let [start, end] = self.tree.legacy_range(node.byte_range);
                    write!(&mut output, ",\"byteRange\":[{start},{end}]")
                        .expect("writing to Vec cannot fail");
                    if let Some(line) = node.line {
                        write!(&mut output, ",\"line\":{line}")
                            .expect("writing to Vec cannot fail");
                    }
                    if node.match_by_kind || node.emit_match_by_kind {
                        output.extend_from_slice(if node.match_by_kind {
                            b",\"matchByKind\":true"
                        } else {
                            b",\"matchByKind\":false"
                        });
                    }
                    write!(
                        &mut output,
                        ",\"height\":{},\"contentHash\":{},\"structureHash\":{},\"children\":[",
                        node.height, node.content_hash, node.structure_hash
                    )
                    .expect("writing to Vec cannot fail");
                    stack.push(Event::Close);
                    if !self.shallow {
                        stack.extend(node.children.iter().rev().copied().map(Event::Node));
                    }
                }
            }
        }
        String::from_utf8(output).map_err(|error| {
            serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shaped(left_nested: bool) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let first = builder.push(NodeSpec::new("x")).unwrap();
        let mut middle = NodeSpec::new("x");
        if left_nested {
            middle.children.push(first);
        }
        let second = builder.push(middle).unwrap();
        let mut third = NodeSpec::new("x");
        if !left_nested {
            third.children.push(second);
        }
        let third = builder.push(third).unwrap();
        let mut root = NodeSpec::new("x");
        root.children = if left_nested {
            vec![second, third]
        } else {
            vec![first, third]
        };
        let root = builder.push(root).unwrap();
        builder.finish(root).unwrap()
    }

    #[test]
    fn forged_hashes_cannot_hide_different_topology_with_identical_postorder_content() {
        let old = shaped(true);
        let mut new = shaped(false);
        for (old_node, new_node) in old
            .nodes
            .iter()
            .zip(&mut Arc::get_mut(&mut new).unwrap().nodes)
        {
            new_node.content_hash = old_node.content_hash;
            new_node.structure_hash = old_node.structure_hash;
        }
        assert!(!trees_equal(&old.root_ref(), &new.root_ref()));
        assert!(!subtrees_equal(
            &old,
            old.root().0,
            &new,
            new.root().0,
            true
        ));
        assert_ne!(
            crate::diff_trees(&old, &new, crate::MatchOptions::default()).changes,
            []
        );
    }

    #[test]
    fn forged_content_hashes_cannot_hide_label_or_value_changes() {
        for change_label in [true, false] {
            let mut old = shaped(true);
            let mut new = shaped(true);
            let old_leaf = &mut Arc::get_mut(&mut old).unwrap().nodes[0];
            let new_leaf = &mut Arc::get_mut(&mut new).unwrap().nodes[0];
            if change_label {
                old_leaf.label = Some("before".to_owned());
                new_leaf.label = Some("after".to_owned());
            } else {
                old_leaf.value = Some("before".to_owned());
                new_leaf.value = Some("after".to_owned());
            }
            assert!(!trees_equal(&old.root_ref(), &new.root_ref()));
            let changes = crate::diff_trees(&old, &new, crate::MatchOptions::default()).changes;
            assert_eq!(changes.len(), 1);
            assert!(matches!(changes[0], crate::EditAction::Update { .. }));
        }
    }
}
