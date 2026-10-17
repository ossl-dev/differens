#![cfg(feature = "serde")]

use differens_core::{MatchOptions, NodeId, NodeSpec, Tree, TreeBuilder, diff_trees, hash_text};
use serde_json::Value;
use std::sync::Arc;

fn build(value: &Value) -> Arc<Tree> {
    fn append(value: &Value, builder: &mut TreeBuilder) -> NodeId {
        let children = value["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|child| append(child, builder))
            .collect();
        let mut spec = NodeSpec::new(value["kind"].as_str().unwrap());
        spec.label = value["label"].as_str().map(str::to_owned);
        spec.value = value["value"].as_str().map(str::to_owned);
        spec.children = children;
        spec.byte_range = serde_json::from_value(value["byteRange"].clone()).unwrap();
        spec.line = value["line"]
            .as_u64()
            .map(|line| usize::try_from(line).unwrap());
        spec.match_by_kind = value["matchByKind"].as_bool().unwrap_or(false);
        spec.emit_match_by_kind = value.get("matchByKind").is_some();
        builder.push(spec).unwrap()
    }
    let mut builder = TreeBuilder::new();
    let root = append(value, &mut builder);
    let tree = builder.finish(root).unwrap();
    assert_eq!(
        tree.node(root).content_hash,
        value["contentHash"].as_u64().unwrap()
    );
    assert_eq!(
        tree.node(root).structure_hash,
        value["structureHash"].as_u64().unwrap()
    );
    tree
}

fn project(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("contentHash");
            object.remove("structureHash");
            object.remove("height");
            object.remove("matchByKind");
            for child in object.values_mut() {
                project(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                project(child);
            }
        }
        _ => {}
    }
}

#[test]
fn every_seeded_legacy_tree_preserves_exact_action_order_and_payload() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/core.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let old = build(&case["old"]);
        let new = build(&case["new"]);
        let result = diff_trees(&old, &new, MatchOptions::default());
        let mut actual = serde_json::to_value(result.changes).unwrap();
        project(&mut actual);
        assert_eq!(actual, case["expected"], "case {}", case["id"]);
    }
}

#[test]
fn legacy_utf16_hash_vectors_match_exactly() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/hashes.json")).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(
            hash_text(case["input"].as_str().unwrap()),
            case["expected"].as_u64().unwrap()
        );
    }
}
