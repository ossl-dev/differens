use differens_core::{EditAction, MatchOptions, NodeSpec, Tree, TreeBuilder, diff_trees};
use std::sync::Arc;

fn tests(names: &[&str]) -> Arc<Tree> {
    let mut builder = TreeBuilder::new();
    let mut children = Vec::new();
    for name in names {
        for (kind, value) in [("Comment", "test description"), ("Attribute", "#[test]")] {
            let mut token = NodeSpec::new("token");
            token.value = Some(value.to_owned());
            let token = builder.push(token).unwrap();
            let mut trivia = NodeSpec::new(kind);
            trivia.children.push(token);
            children.push(builder.push(trivia).unwrap());
        }
        let mut body = NodeSpec::new("body");
        body.value = Some(format!("body of {name}"));
        let body = builder.push(body).unwrap();
        let mut function = NodeSpec::new("Function");
        function.label = Some((*name).to_owned());
        function.children.push(body);
        children.push(builder.push(function).unwrap());
    }
    let mut declarations = NodeSpec::new("declaration_list");
    declarations.children = children;
    let root = builder.push(declarations).unwrap();
    builder.finish(root).unwrap()
}

#[test]
fn adding_test_with_repeated_attributes_and_comments_does_not_move_existing_functions() {
    let old = tests(&["min_depth", "symlinks", "filter", "empty"]);
    let new = tests(&["new_depth_test", "min_depth", "symlinks", "filter", "empty"]);
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert!(result.changes.iter().any(|change| matches!(change,
        EditAction::Insert { node, .. } if node.label.as_deref()==Some("new_depth_test"))));
    assert!(
        !result.changes.iter().any(|change| matches!(change,
        EditAction::Move { node, .. } if node.kind=="Function")),
        "unchanged functions must stay anchored despite ambiguous trivia matches"
    );
    assert!(!result.changes.iter().any(|change| matches!(change,
        EditAction::Delete { node, .. } | EditAction::Update { node, .. } if node.kind=="Function")));
}

#[test]
fn actual_named_function_reorder_remains_a_move() {
    let old = tests(&["first", "second", "third", "fourth"]);
    let new = tests(&["first", "third", "second", "fourth"]);
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert!(result.changes.iter().any(|change| matches!(change,
        EditAction::Move { node, .. } if node.kind=="Function")));
    assert!(!result.changes.iter().any(|change| matches!(change,
        EditAction::Insert { node, .. } | EditAction::Delete { node, .. } if node.kind=="Function")));
}
