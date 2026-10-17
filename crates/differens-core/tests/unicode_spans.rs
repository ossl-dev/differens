use differens_core::{NodeId, NodeSpec, Tree, TreeBuilder};
use std::sync::Arc;

const SOURCE: &str = "const emoji = \"🌍\";\nconst café = 2;\n";

fn mapped() -> Arc<Tree> {
    let mut builder = TreeBuilder::with_source(SOURCE);
    let mut emoji = NodeSpec::new("string_fragment");
    emoji.value = Some("🌍".to_owned());
    emoji.byte_range = [15, 19];
    let emoji = builder.push(emoji).unwrap();
    let mut number = NodeSpec::new("number");
    number.value = Some("2".to_owned());
    number.byte_range = [36, 37];
    let number = builder.push(number).unwrap();
    let mut document = NodeSpec::new("document");
    document.children = vec![emoji, number];
    document.byte_range = [0, SOURCE.len()];
    let root = builder.push(document).unwrap();
    builder.finish(root).unwrap()
}

#[test]
fn mapped_trees_retain_native_byte_spans_and_expose_legacy_code_units() {
    let tree = mapped();
    assert_eq!(tree.node(NodeId(0)).byte_range, [15, 19]);
    assert_eq!(tree.node(NodeId(1)).byte_range, [36, 37]);
    assert_eq!(tree.legacy_range([15, 19]), [15, 17]);
    assert_eq!(tree.legacy_range([36, 37]), [33, 34]);
    assert_eq!(tree.legacy_range([0, 15]), [0, 15]);
    assert_eq!(
        tree.legacy_range([0, SOURCE.len()]),
        [0, SOURCE.encode_utf16().count()]
    );
}

#[test]
fn every_unicode_boundary_matches_a_utf16_reference_including_bom_crlf_and_combining_marks() {
    let source = "\u{feff}é中😀\r\na\u{301}𝄞z";
    let mut builder = TreeBuilder::with_capacity(1);
    builder.set_legacy_source(source);
    let root = builder.push(NodeSpec::new("root")).unwrap();
    let tree = builder.finish(root).unwrap();
    for boundary in source
        .char_indices()
        .map(|(offset, _)| offset)
        .chain([source.len()])
    {
        assert_eq!(
            tree.legacy_range([0, boundary]),
            [0, source[..boundary].encode_utf16().count()]
        );
    }
}

#[test]
fn ascii_and_unmapped_trees_keep_byte_ranges_unchanged() {
    for mut builder in [
        TreeBuilder::new(),
        TreeBuilder::with_source("plain ASCII\r\n"),
    ] {
        let root = builder.push(NodeSpec::new("root")).unwrap();
        let tree = builder.finish(root).unwrap();
        assert_eq!(tree.legacy_range([15, 19]), [15, 19]);
    }
    let mut builder = TreeBuilder::with_source("😀");
    builder.set_legacy_source("ASCII");
    let root = builder.push(NodeSpec::new("root")).unwrap();
    let tree = builder.finish(root).unwrap();
    assert_eq!(tree.legacy_range([0, 4]), [0, 4]);
}

#[cfg(feature = "serde")]
#[test]
fn legacy_json_spans_survive_full_and_shallow_detachment_and_flat_snapshots() {
    let tree = mapped();
    let root = tree.root_ref();
    let json: serde_json::Value = serde_json::from_str(&root.to_json().unwrap()).unwrap();
    assert_eq!(
        json["children"][0]["byteRange"],
        serde_json::json!([15, 17])
    );
    assert_eq!(
        json["children"][1]["byteRange"],
        serde_json::json!([33, 34])
    );
    for node in root.children() {
        for node in [node.clone(), node.shallow()] {
            let expected = node.to_json().unwrap();
            assert_eq!(node.detached().to_json().unwrap(), expected);
            let bytes = serde_json::to_vec(&node.snapshot()).unwrap();
            let restored = serde_json::from_slice::<differens_core::FlatSnapshot>(&bytes)
                .unwrap()
                .into_node_ref()
                .unwrap();
            assert_eq!(restored.to_json().unwrap(), expected);
            assert_eq!(restored.byte_range, node.byte_range);
        }
    }
}

#[cfg(feature = "serde")]
#[test]
fn malformed_offset_maps_cannot_underflow_or_reorder_legacy_coordinates() {
    let original = serde_json::to_value(mapped().root_ref().snapshot()).unwrap();
    for malformed in [
        serde_json::json!([[0, 1]]),
        serde_json::json!([[2, 3]]),
        serde_json::json!([[4, 2], [3, 3]]),
        serde_json::json!([[4, 2], [6, 1]]),
        serde_json::json!([[4, 2], [5, 4]]),
    ] {
        let mut value = original.clone();
        value["legacy_offsets"] = malformed;
        let snapshot = serde_json::from_value::<differens_core::FlatSnapshot>(value).unwrap();
        assert!(snapshot.into_node_ref().is_err());
    }
}
