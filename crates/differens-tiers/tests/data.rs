//! Typed data, format-directed errors, and bounded conversion obligations.
use differens_core::{NodeId, Tree};
use differens_tiers::{ParseError, parse_data, parse_data_as, tree_from_value};
fn scalar<'a>(tree: &'a Tree, label: &str) -> (&'a str, &'a str) {
    let node = (0..tree.len())
        .map(|i| tree.node(NodeId(i)))
        .find(|node| node.label.as_deref() == Some(label) && node.value.is_some())
        .unwrap_or_else(|| panic!("missing scalar {label}"));
    (
        node.scalar_type.as_deref().unwrap(),
        node.value.as_deref().unwrap(),
    )
}
#[test]
fn convenience_parser_infers_each_existing_data_family() {
    for (source, kind, label, expected) in [
        ("{port: 8080}", "object", "port", "8080"),
        ("[1,2]", "array", "root[0]", "1"),
        ("port: 8080", "object", "port", "8080"),
        ("[server]\nport = 8080", "object", "port", "8080"),
        ("HOST=localhost", "object", "HOST", "localhost"),
        ("  text  ", "leaf", "root", "text"),
        (" \n\t ", "leaf", "root", ""),
    ] {
        let tree = parse_data(source).unwrap();
        assert_eq!(tree.node(tree.root()).kind, kind);
        assert_eq!(scalar(&tree, label).1, expected);
    }
    assert!(parse_data("{broken").is_err());
}
#[test]
fn json5_and_yaml_keep_scalar_types_collections_and_document_order() {
    let source = "{name:'app', enabled:true, disabled:false, count:3, ratio:0.5, nothing:null, items:[1,'1',false], trailing:1,}";
    for extension in ["json5", "jsonc"] {
        let tree = parse_data_as(source, extension).unwrap();
        for (label, kind, value) in [
            ("name", "string", "app"),
            ("enabled", "boolean", "true"),
            ("disabled", "boolean", "false"),
            ("count", "number", "3"),
            ("ratio", "number", "0.5"),
            ("nothing", "null", "null"),
            ("items[0]", "number", "1"),
            ("items[1]", "string", "1"),
            ("items[2]", "boolean", "false"),
        ] {
            assert_eq!(scalar(&tree, label), (kind, value));
        }
    }
    let source = "name: app\nenabled: true\ndisabled: false\ncount: 3\nratio: 0.5\nnothing: null\nitems: [1, '1', false]\n";
    let tree = parse_data_as(source, "yaml").unwrap();
    for (label, kind, value) in [
        ("name", "string", "app"),
        ("enabled", "boolean", "true"),
        ("disabled", "boolean", "false"),
        ("count", "number", "3"),
        ("ratio", "number", "0.5"),
        ("nothing", "null", "null"),
        ("items[0]", "number", "1"),
        ("items[1]", "string", "1"),
        ("items[2]", "boolean", "false"),
    ] {
        assert_eq!(scalar(&tree, label), (kind, value));
    }
    let documents = parse_data_as("---\nfirst: 1\n---\nsecond: 2\n", "yaml").unwrap();
    assert_eq!(documents.node(documents.root()).kind, "array");
    assert_eq!(scalar(&documents, "first"), ("number", "1"));
    assert_eq!(scalar(&documents, "second"), ("number", "2"));
    for source in ["", "null", "~"] {
        let tree = parse_data_as(source, "yaml").unwrap();
        assert_eq!(scalar(&tree, "root"), ("null", "null"));
    }
}
#[test]
fn ini_env_sections_exports_comments_and_empty_values_are_retained() {
    let source = "; comment\n# comment\n\nexport COUNT=3\nEMPTY=\nFLAG=true\nURL=https://example.test:443/path\nLIST=[1,2]\nBROKEN=[not, json]\n[server.tls]\nenabled=false\n";
    for extension in ["ini", "cfg", "env", "local"] {
        let tree = parse_data_as(source, extension).unwrap();
        for (label, kind, value) in [
            ("COUNT", "number", "3"),
            ("EMPTY", "string", ""),
            ("FLAG", "boolean", "true"),
            ("URL", "string", "https://example.test:443/path"),
            ("LIST[0]", "number", "1"),
            ("BROKEN", "string", "[not, json]"),
            ("enabled", "boolean", "false"),
        ] {
            assert_eq!(scalar(&tree, label), (kind, value));
        }
    }
    assert!(matches!(
        parse_data_as("invalid line", "ini"),
        Err(ParseError::Syntax(_))
    ));
    assert!(matches!(
        parse_data_as("server=1\n[server]\nport=80", "ini"),
        Err(ParseError::Syntax(_))
    ));
}
#[test]
fn malformed_data_stays_an_explicit_parse_error() {
    for (extension, source) in [
        ("json", "{oops"),
        ("json5", "{oops"),
        ("yaml", "x: [1,2"),
        ("yaml", "42: value"),
        ("yaml", "flag: .inf"),
        ("toml", "[unclosed"),
    ] {
        assert!(
            matches!(parse_data_as(source, extension), Err(ParseError::Syntax(_))),
            "{extension} {source}"
        );
    }
    let tree = parse_data_as(" raw value ", "unknown").unwrap();
    assert_eq!(scalar(&tree, "root"), ("string", "raw value"));
}
#[test]
fn structured_conversion_rejects_excess_nodes_or_depth_without_losing_raw_fallback() {
    let wide = serde_json::Value::Array(vec![serde_json::Value::Null; 50_000]);
    assert!(matches!(tree_from_value(&wide), Err(ParseError::Budget)));
    let mut deep = serde_json::Value::Bool(true);
    for _ in 0..257 {
        deep = serde_json::Value::Array(vec![deep]);
    }
    assert!(matches!(tree_from_value(&deep), Err(ParseError::Budget)));
    let mut yaml = String::new();
    for depth in 0..258 {
        yaml.push_str(&" ".repeat(depth * 2));
        yaml.push_str("a:\n");
    }
    yaml.push_str(&" ".repeat(258 * 2));
    yaml.push_str("value: 1\n");
    assert!(matches!(
        parse_data_as(&yaml, "yaml"),
        Err(ParseError::Budget)
    ));
    let old = serde_json::to_vec(&wide).unwrap();
    let mut changed = wide;
    changed.as_array_mut().unwrap()[0] = serde_json::Value::Bool(true);
    let new = serde_json::to_vec(&changed).unwrap();
    let result = differens_tiers::diff_with_tier(
        &old,
        &new,
        "a.json",
        "a.json",
        differens_tiers::SourcePresence::default(),
    );
    assert_eq!(result.tier, differens_tiers::Tier::Raw);
    assert_eq!(result.fallback.as_deref(), Some("lines"));
    assert_ne!(result.changes, []);
}

#[test]
fn streaming_yaml_limits_depth_and_alias_expansion_before_recursive_loading() {
    let deep = format!("{}0{}", "[".repeat(5000), "]".repeat(5000));
    assert!(matches!(
        parse_data_as(&deep, "yaml"),
        Err(ParseError::Syntax(message)) if message.contains("recursion limit")
    ));
    let normal = "base: &base [1, 2, 3]\ncopy: *base\n";
    let tree = parse_data_as(normal, "yaml").unwrap();
    assert_eq!(scalar(&tree, "copy[1]"), ("number", "2"));
    let expanded = "a: &a [1,2,3,4,5,6,7,8,9,10]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]\n";
    assert!(matches!(
        parse_data_as(expanded, "yaml"),
        Err(ParseError::Budget)
    ));
    let result = differens_tiers::diff_with_tier(
        expanded.as_bytes(),
        expanded.replace("1,2", "9,2").as_bytes(),
        "a.yaml",
        "a.yaml",
        differens_tiers::SourcePresence::default(),
    );
    assert_eq!(result.tier, differens_tiers::Tier::Raw);
    assert_ne!(result.changes, []);
    let documents = "---\nfirst: &base [1]\n---\nsecond: &base [2]\ncopy: *base\n";
    let tree = parse_data_as(documents, "yaml").unwrap();
    assert_eq!(scalar(&tree, "copy[0]"), ("number", "2"));
}

#[test]
fn adversarial_data_depth_is_bounded_in_a_subprocess() {
    const CHILD: &str = "DIFFERENS_ADVERSARIAL_DATA_CHILD";
    if std::env::var_os(CHILD).is_some() {
        for depth in [16, 64, 128, 255, 256, 5000] {
            let brackets = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
            for (extension, source) in [
                ("json5", brackets.clone()),
                ("toml", format!("value={brackets}")),
                ("toml", format!("{}value=1", "a.".repeat(depth))),
            ] {
                let result = parse_data_as(&source, extension);
                if depth == 16 {
                    assert!(result.is_ok(), "{extension} {depth}");
                }
                if depth == 5000 {
                    assert!(result.is_err(), "{extension} must reject depth{depth}");
                }
            }
        }
        return;
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "adversarial_data_depth_is_bounded_in_a_subprocess",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .status()
        .unwrap();
    assert!(
        status.success(),
        "deep data child aborted or exceeded its parser budget"
    );
}
