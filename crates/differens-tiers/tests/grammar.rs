#![cfg(feature = "code")]
use differens_core::NodeId;
use differens_tiers::{list_languages, parse_code};
use std::fmt::Write;

#[test]
fn every_frozen_dialect_loads_and_preserves_labels() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/grammars.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let tree = parse_code(source, case["extension"].as_str().unwrap(), 50_000).unwrap();
        assert_eq!(tree.node(tree.root()).kind, "file", "{}", case["dialect"]);
        assert!(
            (0..tree.len()).any(|i| {
                let n = tree.node(NodeId(i));
                n.kind == case["concept"].as_str().unwrap()
                    && n.label.as_deref() == case["label"].as_str()
            }),
            "{} missing labelled construct",
            case["dialect"]
        );
    }
    assert_eq!(list_languages().len(), 16);
}

#[test]
fn code_preserves_operators_unicode_and_budget() {
    let tree = parse_code("const café = a + b;", "ts", 50_000).unwrap();
    assert!((0..tree.len()).any(|i| tree.node(NodeId(i)).value.as_deref() == Some("+")));
    assert!((0..tree.len()).any(|i| tree.node(NodeId(i)).label.as_deref() == Some("café")));
    assert!(parse_code("const café = a + b;", "ts", 1).is_err());
}

#[test]
fn depth_node_source_and_cache_budgets_remain_enforced() {
    use differens_tiers::{SourcePresence, Tier, diff_with_tier};
    let nested = format!("const x = {}0{};", "[".repeat(300), "]".repeat(300));
    assert!(parse_code(&nested, "ts", 50_000).is_err());
    let many = (0..12_000).fold(String::new(), |mut output, i| {
        writeln!(output, "const value{i} = {i};").unwrap();
        output
    });
    assert!(parse_code(&many, "ts", 50_000).is_err());
    let result = diff_with_tier(
        many.as_bytes(),
        many.replace("value9000", "changed9000").as_bytes(),
        "a.ts",
        "a.ts",
        SourcePresence::default(),
    );
    assert_eq!(result.tier, Tier::Raw);
    assert_eq!(result.fallback.as_deref(), Some("lines"));
    assert_ne!(result.changes, []);
    // Exceed the entry, byte, and node limits with distinct content. Reparse
    // the first item after eviction, preserving identical tree identity.
    differens_tiers::clear_parse_cache();
    let first = "function original() { return 1; }";
    let original = parse_code(first, "ts", 50_000).unwrap();
    for i in 0..80 {
        let source = format!(
            "// {}\nfunction cached{i}() {{ return {i}; }}",
            "x".repeat(30_000)
        );
        parse_code(&source, "ts", 50_000).unwrap();
    }
    let stats = differens_tiers::parse_cache_stats();
    assert!(stats.entries <= 64 && stats.nodes <= 50_000 && stats.source_bytes <= 2_000_000);
    assert_eq!(stats.misses, 81);
    let again = parse_code(first, "ts", 50_000).unwrap();
    assert!(
        !std::sync::Arc::ptr_eq(&original, &again),
        "first tree must have been evicted by byte budget"
    );
    let cached = parse_code(first, "ts", 50_000).unwrap();
    assert!(std::sync::Arc::ptr_eq(&again, &cached));
    assert_eq!(differens_tiers::parse_cache_stats().hits, 1);
    assert!(differens_core::trees_equal(
        &original.root_ref(),
        &again.root_ref()
    ));
    assert!(parse_code(first, "ts", 1).is_err());
    let huge = format!("// {}\nconst x=1;", "x".repeat(1_000_000));
    let result = diff_with_tier(
        huge.as_bytes(),
        huge.replace("x=1", "x=2").as_bytes(),
        "a.ts",
        "a.ts",
        SourcePresence::default(),
    );
    assert_eq!(result.tier, Tier::Raw);
    assert_ne!(result.changes, []);
}

#[test]
fn unicode_code_keeps_utf8_internally_and_legacy_utf16_on_the_wire() {
    let source = "// 😀\nconst café = \"😀\";\n";
    let tree = parse_code(source, "ts", 50_000).unwrap();
    let identifier = (0..tree.len())
        .map(NodeId)
        .find(|id| {
            let node = tree.node(*id);
            node.kind == "identifier" && node.value.as_deref() == Some("café")
        })
        .unwrap();
    assert_eq!(tree.node(identifier).byte_range, [14, 19]);
    let wire = serde_json::to_value(differens_core::NodeRef::new(
        std::sync::Arc::clone(&tree),
        identifier,
    ))
    .unwrap();
    assert_eq!(wire["byteRange"], serde_json::json!([12, 16]));
    for i in 0..tree.len() {
        let node = tree.node(NodeId(i));
        let expected = node
            .byte_range
            .map(|offset| source[..offset].encode_utf16().count());
        let wire = serde_json::to_value(differens_core::NodeRef::new(
            std::sync::Arc::clone(&tree),
            NodeId(i),
        ))
        .unwrap();
        assert_eq!(wire["byteRange"], serde_json::json!(expected));
    }
}
