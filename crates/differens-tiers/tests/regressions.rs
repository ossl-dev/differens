#[cfg(feature = "code")]
use differens_core::{EditAction, NodeId, UpdateDetail};
#[cfg(feature = "code")]
use differens_tiers::parse_code;
use differens_tiers::{SourcePresence, diff_with_tier};
fn diff(old: &str, new: &str, path: &str) -> differens_tiers::TierDiffResult {
    diff_with_tier(
        old.as_bytes(),
        new.as_bytes(),
        path,
        path,
        SourcePresence::default(),
    )
}
#[test]
fn trailing_slashes_in_unquoted_markup_urls_are_semantic() {
    let result = diff(
        "<a href=/api title=x>same</a>",
        "<a href=/api/ title=x>same</a>",
        "a.html",
    );
    assert_ne!(result.changes, []);
}
#[test]
fn text_position_relative_to_inline_elements_is_semantic() {
    let result = diff(
        "<p>hello<b>bold</b></p>",
        "<p><b>bold</b>hello</p>",
        "a.html",
    );
    assert_ne!(result.changes, []);
}
#[cfg(feature = "code")]
#[test]
fn c_declarator_labels_ignore_pointer_and_array_syntax() {
    for (extension, source, kind, label) in [
        ("c", "static const char *name = \"x\";", "Variable", "name"),
        ("c", "int values[4];", "Variable", "values"),
        (
            "c",
            "const char *run(void) { return \"x\"; }",
            "Function",
            "run",
        ),
        (
            "cpp",
            "class C { int *value; int (*callback)(int); };",
            "Variable",
            "callback",
        ),
    ] {
        let tree = parse_code(source, extension, 50_000).unwrap();
        assert!(
            (0..tree.len())
                .map(|i| tree.node(NodeId(i)))
                .any(|node| node.kind == kind && node.label.as_deref() == Some(label)),
            "{extension}: {source}"
        );
    }
    let result = diff("int values[4];", "int values[8];", "a.c");
    assert!(
        !result.changes.iter().any(|change| matches!(
            change,
            EditAction::Update {
                detail: UpdateDetail::Renamed { .. },
                ..
            }
        )),
        "array dimensions are not identifier renames"
    );
}
#[test]
fn nonfinite_json5_values_never_collapse_to_null() {
    for (old, new) in [
        ("{limit: Infinity}", "{limit: -Infinity}"),
        ("{limit: NaN}", "{limit: null}"),
        ("{limit: 1e400}", "{limit: null}"),
    ] {
        let result = diff(old, new, "config.json5");
        assert_ne!(result.changes, [], "{old} -> {new}");
    }
}

#[cfg(feature = "code")]
#[test]
fn flask_decorated_functions_and_annotated_class_fields_have_names() {
    let source = "class Scaffold:\n    @setupmethod\n    def query(self, rule: str):\n        return self._method_route(\"QUERY\", rule)\n\nclass Flask(App):\n    default_config: Mapping[str, Any] = {\"DEBUG\": None}\n    self_name = \"flask\"\n";
    let tree = parse_code(source, "py", 50_000).unwrap();
    for (kind, label) in [
        ("DecoratedDef", "query"),
        ("Assignment", "default_config"),
        ("Assignment", "self_name"),
    ] {
        assert!(
            (0..tree.len())
                .map(|i| tree.node(NodeId(i)))
                .any(|node| node.kind == kind && node.label.as_deref() == Some(label)),
            "{kind} {label}"
        );
    }
}
#[test]
fn json_string_brackets_comments_and_finite_values_still_parse_semantically() {
    let brackets = "[".repeat(600);
    let old = format!("{{string:'{brackets}', /* {brackets} */ value:1}}");
    let new = old.replace("value:1", "value:2");
    let result = diff(&old, &new, "a.json5");
    assert_eq!(result.tier, differens_tiers::Tier::Data);
    assert_eq!(result.changes.len(), 1);
    let quoted = diff("{limit:'Infinity'}", "{limit:'NaN'}", "a.json5");
    assert_eq!(quoted.tier, differens_tiers::Tier::Data);
    assert_ne!(quoted.changes, []);
}
#[test]
fn json_family_budgets_reject_density_before_full_parser_materialization() {
    let wide = format!("[{}0]", "0,".repeat(100_000));
    for extension in ["json", "json5"] {
        assert!(matches!(
            differens_tiers::parse_data_as(&wide, extension),
            Err(differens_tiers::ParseError::Budget)
        ));
    }
    let dense_env = format!("LIST={wide}");
    assert!(matches!(
        differens_tiers::parse_data_as(&dense_env, "env"),
        Err(differens_tiers::ParseError::Budget)
    ));
    let deep = format!("{}0{}", "[".repeat(5000), "]".repeat(5000));
    assert!(matches!(
        differens_tiers::parse_data_as(&deep, "json5"),
        Err(differens_tiers::ParseError::Budget)
    ));
}
#[test]
fn mixed_text_comments_and_formatting_do_not_erase_content() {
    let result = diff(
        "<p>a<!-- note -->b<i>c</i>d</p>",
        "<p>ab<i>c</i>d</p>",
        "a.html",
    );
    assert_eq!(result.changes, []);
    let result = diff("<p>ab<i>c</i>d</p>", "<p>abd<i>c</i></p>", "a.html");
    assert_ne!(result.changes, []);
}

#[test]
fn nonfinite_toml_values_never_collapse_to_null() {
    for (old, new) in [("limit=inf", "limit=-inf"), ("limit=nan", "limit=1.0")] {
        assert_ne!(diff(old, new, "config.toml").changes, []);
    }
}

#[test]
fn toml_temporal_values_preserve_legacy_typed_leaf_shapes() {
    let source =
        "date=1979-05-27\ntime=07:32:00\nlocal=1979-05-27T07:32:00\noffset=1979-05-27T07:32:00Z\n";
    let actual = differens_tiers::parse_data_as(source, "toml").unwrap();
    for (label, text) in [
        ("date", "1979-05-27"),
        ("time", "07:32:00"),
        ("local", "1979-05-27T07:32:00"),
        ("offset", "1979-05-27T07:32:00Z"),
    ] {
        assert!(
            (0..actual.len())
                .map(|i| actual.node(differens_core::NodeId(i)))
                .any(|node| node.label.as_deref() == Some(label)
                    && node.value.as_deref() == Some(text)
                    && node.scalar_type.as_deref() == Some("string")),
            "missing {label} datetime scalar"
        );
    }
}
#[test]
fn json5_integer_boundaries_remain_exact_or_fall_back_without_narrowing() {
    for value in [
        "9007199254740993",
        "9223372036854775807",
        "-9223372036854775808",
    ] {
        let source = format!("{{value:{value}}}");
        let tree = differens_tiers::parse_data_as(&source, "json5").unwrap();
        assert!(
            (0..tree.len())
                .map(|i| tree.node(differens_core::NodeId(i)))
                .any(|node| node.label.as_deref() == Some("value")
                    && node.value.as_deref() == Some(value))
        );
    }
    assert_ne!(
        diff(
            "{value:9007199254740992}",
            "{value:9007199254740993}",
            "a.json5"
        )
        .changes,
        []
    );
    for source in ["{value:9223372036854775808}", "{value:0x100000000}"] {
        assert!(differens_tiers::parse_data_as(source, "json5").is_err());
        assert_ne!(diff(source, "{value:0}", "a.json5").changes, []);
    }
}
#[test]
fn json5_budget_scanner_preserves_utf8_and_escaped_string_delimiters() {
    let literal = "café 😀 \\\" // [ { ] } /* still text */".repeat(300);
    let quoted = serde_json::to_string(&literal).unwrap();
    let source = format!("{{text:{quoted}, other:'it\\'s [', /* }} ]] */ value:1}}");
    let tree = differens_tiers::parse_data_as(&source, "json5").unwrap();
    assert!(
        (0..tree.len())
            .map(|i| tree.node(differens_core::NodeId(i)))
            .any(|node| node.label.as_deref() == Some("text")
                && node.value.as_deref() == Some(literal.as_str()))
    );
    let result = diff(&source, &source.replace("value:1", "value:2"), "a.json5");
    assert_eq!(result.tier, differens_tiers::Tier::Data);
    assert_eq!(result.changes.len(), 1);
}

#[test]
fn toml_private_datetime_user_keys_are_not_silently_coerced() {
    let source = "private={\"$__toml_private_datetime\"=\"1979-05-27\"}";
    let tree = differens_tiers::parse_data_as(source, "toml").unwrap();
    assert!(
        (0..tree.len())
            .map(|i| tree.node(differens_core::NodeId(i)))
            .any(|node| node.kind == "object" && node.label.as_deref() == Some("private"))
    );
    assert_ne!(diff(source, "private=1979-05-27", "a.toml").changes, []);
    let result = diff(
        "private={\"$__toml_private_datetime\"=\"user old\"}",
        "private={\"$__toml_private_datetime\"=\"user new\"}",
        "a.toml",
    );
    assert_ne!(result.changes, []);
}

#[cfg(feature = "code")]
#[test]
fn go_receiver_identity_pairs_overloaded_methods_without_changing_labels() {
    use std::fmt::Write;
    let receivers = [
        "flushWriter",
        "flushHijackWriter",
        "httpFancyWriter",
        "http2FancyWriter",
    ];
    let mut old = "package middleware\n".to_owned();
    let mut new = old.clone();
    for receiver in receivers {
        writeln!(old,"func (f *{receiver}) Flush() {{ f.wroteHeader = true; fl := f.basicWriter.ResponseWriter.(http.Flusher); fl.Flush() }}").unwrap();
        writeln!(
            new,
            "func (f *{receiver}) Flush() {{ f.basicWriter.flush() }}"
        )
        .unwrap();
    }
    let tree = parse_code(&new, "go", 50_000).unwrap();
    for receiver in receivers {
        assert!((0..tree.len()).map(NodeId).any(|id| {
            let node = tree.node(id);
            node.kind == "Method"
                && node.label.as_deref() == Some("Flush")
                && tree.match_key(id) == Some(format!("go::{receiver}").as_str())
        }));
    }
    let result = diff(&old, &new, "wrap_writer.go");
    assert!(!result.changes.iter().any(|action|matches!(action,EditAction::Insert{node,..}|EditAction::Delete{node,..} if node.kind=="Method" && node.label.as_deref()==Some("Flush"))),"changed receiver methods must pair, rather than delete/reinsert: {:?}",result.changes);
    let source = "package middleware\ntype Box[T any] struct {}\nfunc (b *Box[T]) Flush() {}\n";
    let tree = parse_code(source, "go", 50_000).unwrap();
    assert!(
        (0..tree.len())
            .map(NodeId)
            .any(|id| tree.node(id).kind == "Method" && tree.match_key(id) == Some("go::Box"))
    );
}

#[test]
fn toml_typed_ast_preserves_sections_arrays_and_legacy_finite_values() {
    let source = "title=\"app\"\n[server]\nports=[80,443]\nenabled=true\nratio=0.5\n[[workers]]\nname=\"first\"\n[[workers]]\nname=\"second\"\n";
    let old: toml::Value = toml::from_str(source).unwrap();
    let expected = differens_tiers::tree_from_value(&serde_json::to_value(old).unwrap()).unwrap();
    let actual = differens_tiers::parse_data_as(source, "toml").unwrap();
    assert!(differens_core::trees_equal(
        &expected.root_ref(),
        &actual.root_ref()
    ));
}
