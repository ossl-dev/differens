//! Paragraph matching and word edits with synthetic local UTF-16 ranges.
use crate::{router::hunk_action, sequence::diff_words};
use differens_core::{
    EditAction, MatchOptions, NodeContext, NodeSpec, TreeBuilder, UpdateDetail, diff_trees,
};
fn paragraph_tree(source: &str) -> std::sync::Arc<differens_core::Tree> {
    let mut builder = TreeBuilder::new();
    let mut children = Vec::new();
    let mut rest = source;
    while let Some(boundary) = rest.find("\n\n") {
        push_paragraph(&mut builder, &mut children, &rest[..boundary]);
        rest = rest[boundary..].trim_start_matches('\n');
    }
    push_paragraph(&mut builder, &mut children, rest);
    let mut spec = NodeSpec::new("document");
    spec.children = children;
    // Prose ranges are synthetic, preserving legacy UTF-16 widths.
    spec.byte_range = [0, source.encode_utf16().count()];
    let root = builder.push(spec).expect("valid document tree");
    builder.finish(root).expect("valid paragraph topology")
}
fn push_paragraph(
    builder: &mut TreeBuilder,
    children: &mut Vec<differens_core::NodeId>,
    text: &str,
) {
    let text = text.trim_end();
    let mut spec = NodeSpec::new("paragraph");
    spec.value = Some(text.to_owned());
    spec.byte_range = [0, text.encode_utf16().count()];
    children.push(builder.push(spec).expect("valid paragraph"));
}
#[must_use]
pub fn diff_prose_actions(old: &str, new: &str) -> Vec<EditAction> {
    let result = diff_trees(
        &paragraph_tree(old),
        &paragraph_tree(new),
        MatchOptions::default(),
    );
    let mut actions = Vec::new();
    for change in result.changes {
        if let EditAction::Update {
            node,
            detail: UpdateDetail::ValueChanged { from, to },
            ..
        } = &change
        {
            if node.kind == "paragraph" {
                actions.extend(
                    diff_words(from.as_deref().unwrap_or(""), to.as_deref().unwrap_or(""))
                        .into_iter()
                        .enumerate()
                        .map(|(i, hunk)| {
                            hunk_action(
                                hunk,
                                "word",
                                "paragraph",
                                i,
                                vec![NodeContext {
                                    kind: "paragraph".to_owned(),
                                    label: None,
                                }],
                            )
                        }),
                );
                continue;
            }
        }
        actions.push(change);
    }
    actions
}
