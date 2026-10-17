use differens_core::{EditAction, NodeId, UpdateDetail};
use differens_tiers::{SourcePresence, Tier, diff_with_tier, parse_data_as, parse_markup};
fn diff(old: &str, new: &str, path: &str) -> differens_tiers::TierDiffResult {
    diff_with_tier(
        old.as_bytes(),
        new.as_bytes(),
        path,
        path,
        SourcePresence::default(),
    )
}
fn value(tree: &differens_core::Tree, label: &str) -> Option<String> {
    (0..tree.len()).find_map(|i| {
        let node = tree.node(NodeId(i));
        (node.label.as_deref() == Some(label))
            .then(|| node.value.clone())
            .flatten()
    })
}
#[test]
fn binary_original_bytes_remain_distinct() {
    let result = diff_with_tier(
        &[0xff],
        &[0xfe],
        "a.dat",
        "a.dat",
        SourcePresence::default(),
    );
    assert_eq!(result.tier, Tier::Binary);
    assert_eq!(result.changes.len(), 1);
    let utf8 = diff("a\u{fffd}", "b\u{fffd}", "a.dat");
    assert_eq!(utf8.tier, Tier::Raw);
}
#[test]
fn every_markup_attribute_survives() {
    for (old, new) in [
        ("<img src='a'>", "<img src='b'>"),
        ("<input>", "<input disabled>"),
        ("<div data-x=one></div>", "<div data-x=two></div>"),
        ("<x:item xml:lang='en'/>", "<x:item xml:lang='fr'/>"),
    ] {
        let result = diff(old, new, "a.html");
        assert_eq!(result.tier, Tier::Markup);
        assert!(!result.changes.is_empty(), "{old} -> {new}");
    }
    let tree = parse_markup("<div title='a > b'>x</div>").unwrap();
    assert_eq!(value(&tree, "title").as_deref(), Some("a > b"));
    assert_eq!(
        diff("<div a='1' b='2'/>", "<div b='2' a='1'/>", "a.xml").changes,
        []
    );
}
#[test]
fn typed_data_scalars_never_collapse() {
    for (old, new) in [
        ("{\"x\":1}", "{\"x\":\"1\"}"),
        ("{\"x\":true}", "{\"x\":\"true\"}"),
        ("{\"x\":null}", "{\"x\":\"null\"}"),
    ] {
        let result = diff(old, new, "a.json");
        assert_eq!(result.tier, Tier::Data);
        assert!(!result.changes.is_empty(), "{old} -> {new}");
    }
}
#[test]
fn yaml_arbitrary_indent_nested_sequences_and_blocks() {
    let source = "db:\n    host: localhost\n    pool:\n        max: 10\nitems:\n    - name: one\n      port: 80\ntext: |\n    first\n    second\n";
    let tree = parse_data_as(source, "yaml").unwrap();
    assert_eq!(value(&tree, "host").as_deref(), Some("localhost"));
    assert_eq!(value(&tree, "max").as_deref(), Some("10"));
    assert_eq!(value(&tree, "port").as_deref(), Some("80"));
    let result = diff(source, &source.replace("max: 10", "max: 25"), "a.yaml");
    assert_eq!(result.tier, Tier::Data);
    assert_ne!(result.changes, []);
}
#[test]
fn formats_preserve_values_and_invalid_input_falls_back() {
    for (extension, source, label, expected) in [
        ("toml", "[a.b]\nport = 8080\n", "port", "8080"),
        ("json5", "{port:8080, // hi\n}", "port", "8080"),
        ("ini", "[server]\nhost=localhost\n", "host", "localhost"),
        ("env", "PORT=8080\nHOST=localhost\n", "HOST", "localhost"),
    ] {
        let tree = parse_data_as(source, extension).unwrap();
        assert_eq!(value(&tree, label).as_deref(), Some(expected));
    }
    let result = diff("{oops", "{oops!", "a.json");
    assert_eq!(result.tier, Tier::Raw);
    assert_eq!(result.fallback.as_deref(), Some("lines"));
    assert_ne!(result.changes, []);
}
#[test]
fn real_empty_existing_file_differs_from_absent_file() {
    let result = diff("", "const x = 1;", "a.ts");
    assert_ne!(result.changes, []);
    let result = diff_with_tier(
        b"",
        b"const x = 1;",
        "a.ts",
        "a.ts",
        SourcePresence {
            old_exists: false,
            new_exists: true,
        },
    );
    assert_eq!(result.changes.len(), 1);
    assert_eq!(result.changes[0].node().kind, "file");
}
#[test]
fn prose_word_changes_and_paragraph_moves() {
    let result = diff("hello world", "hello  world", "a.txt");
    assert!(result.changes.iter().any(|change|matches!(change,EditAction::Update{detail:UpdateDetail::ValueChanged{from:Some(from),to:Some(to)},..} if from==" " && to=="  ")));
    let result = diff(
        "first paragraph\n\nsecond paragraph\n\nthird paragraph",
        "third paragraph\n\nfirst paragraph\n\nsecond paragraph",
        "a.txt",
    );
    assert!(
        result
            .changes
            .iter()
            .any(|change| matches!(change, EditAction::Move { .. }))
    );
}
#[test]
fn binary_plugins_receive_exact_bytes_and_may_decline() {
    use differens_tiers::{BinaryDiffPlugin, register_binary_plugin, unregister_binary_plugin};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct Plugin(Arc<AtomicUsize>);
    impl BinaryDiffPlugin for Plugin {
        fn id(&self) -> &'static str {
            "exact-bytes-test"
        }
        fn extensions(&self) -> &[&str] {
            &["testbin"]
        }
        fn diff(
            &self,
            old: &[u8],
            new: &[u8],
        ) -> Result<Option<Vec<EditAction>>, Box<dyn std::error::Error + Send + Sync>> {
            assert_eq!(old, [0xff]);
            assert_eq!(new, [0xfe]);
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(None)
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    register_binary_plugin(Arc::new(Plugin(Arc::clone(&calls))));
    let result = diff_with_tier(
        &[0xff],
        &[0xfe],
        "a.testbin",
        "a.testbin",
        SourcePresence::default(),
    );
    assert_eq!(result.changes.len(), 1);
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(unregister_binary_plugin("exact-bytes-test"));
    assert!(!unregister_binary_plugin("exact-bytes-test"));
}

#[test]
fn markup_unicode_text_attributes_and_malformed_input_are_safe() {
    for source in [
        "é",
        "世界",
        "é <b title='你好'>café</b> 終",
        "3 < 4 and é < 5",
        "<div title='世界 > é'>雪</div>",
    ] {
        let tree = parse_markup(source).unwrap();
        assert!(!tree.is_empty());
    }
    let tree = parse_markup("<div title='世界 > é'>雪</div>").unwrap();
    assert_eq!(value(&tree, "title").as_deref(), Some("世界 > é"));
    let result = diff("<p>é</p>", "<p>雪</p>", "a.html");
    assert_eq!(result.changes.len(), 1);
}

#[test]
fn whole_file_binary_identity_is_lossless() {
    let presence = SourcePresence {
        old_exists: false,
        new_exists: true,
    };
    let first = diff_with_tier(b"", &[0xff], "a.bin", "a.bin", presence);
    let second = diff_with_tier(b"", &[0xfe], "a.bin", "a.bin", presence);
    assert_ne!(
        first.changes[0].node().content_hash,
        second.changes[0].node().content_hash
    );
    assert!(!differens_core::trees_equal(
        first.changes[0].node(),
        second.changes[0].node()
    ));
}

#[test]
fn noncode_unicode_ranges_keep_their_legacy_coordinates() {
    let data = parse_data_as("{\"word\":\"café 😀\"}", "json").unwrap();
    let node = (0..data.len())
        .map(|i| data.node(NodeId(i)))
        .find(|node| node.label.as_deref() == Some("word"))
        .unwrap();
    assert_eq!(node.byte_range, [0, 7]);
    let raw = diff("old", "café 😀", "a.raw");
    assert_eq!(raw.changes[0].node().byte_range, [0, 7]);
    assert_eq!(
        serde_json::to_value(raw.changes[0].node()).unwrap()["byteRange"],
        serde_json::json!([0, 7])
    );
    let prose = diff("old", "café 😀", "a.txt");
    assert!(
        prose
            .changes
            .iter()
            .any(|action| action.node().value.as_deref() == Some("😀")
                && action.node().byte_range == [0, 2])
    );
    let markup = parse_markup("é<p>😀</p>").unwrap();
    let id = (0..markup.len())
        .map(NodeId)
        .find(|id| markup.node(*id).kind == "p")
        .unwrap();
    assert_eq!(markup.node(id).byte_range, [2, 13]);
    assert_eq!(
        serde_json::to_value(differens_core::NodeRef::new(
            std::sync::Arc::clone(&markup),
            id
        ))
        .unwrap()["byteRange"],
        serde_json::json!([1, 10])
    );
    let added = diff_with_tier(
        b"",
        "café 😀".as_bytes(),
        "a.txt",
        "a.txt",
        SourcePresence {
            old_exists: false,
            new_exists: true,
        },
    );
    assert_eq!(added.changes[0].node().byte_range, [0, 10]);
    assert_eq!(
        serde_json::to_value(added.changes[0].node()).unwrap()["byteRange"],
        serde_json::json!([0, 7])
    );
    let binary = diff_with_tier(
        b"",
        "café 😀".as_bytes(),
        "a.bin",
        "a.bin",
        SourcePresence {
            old_exists: false,
            new_exists: true,
        },
    );
    assert_eq!(
        serde_json::to_value(binary.changes[0].node()).unwrap()["byteRange"],
        serde_json::json!([0, 10])
    );
}
