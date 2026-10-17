use differens_core::{EditAction, NodeSpec, TreeBuilder, UpdateDetail};
use differens_tiers::{
    BinaryDiffPlugin, SourcePresence, Tier, classify_file, diff_with_tier, is_parseable,
    register_binary_plugin, unregister_binary_plugin,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
#[test]
fn classification_and_numeric_tiers_match_the_public_contract() {
    for (path, tier) in [
        ("CONFIG.JSON", Tier::Data),
        (".env.local", Tier::Data),
        ("layout.xml", Tier::Markup),
        ("LOGO.PNG", Tier::Binary),
        ("README", Tier::Prose),
        ("LICENSE", Tier::Prose),
        ("CHANGELOG", Tier::Prose),
        ("AUTHORS", Tier::Prose),
        ("data.csv", Tier::Raw),
        ("Dockerfile", Tier::Raw),
        ("README.md", Tier::Raw),
        ("App.Ts", Tier::Code),
        ("Makefile", Tier::Raw),
    ] {
        assert_eq!(classify_file(path).tier, tier);
        assert_eq!(
            serde_json::to_value(tier).unwrap(),
            serde_json::Value::from(tier as u8)
        );
    }
    for path in ["config.json", "index.html"] {
        assert!(is_parseable(path));
    }
    for path in ["main.css", "README.md", "notes.txt"] {
        assert!(!is_parseable(path));
    }
    assert_eq!(is_parseable("app.ts"), cfg!(feature = "code"));
    let result = diff_with_tier(
        b"a",
        b"b",
        "file.xyz",
        "file.xyz",
        SourcePresence::default(),
    );
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["tier"], 1);
    assert!(value.get("nodeCount").is_some());
    assert!(value.get("fallback").is_none());
}
struct Plugin {
    mode: u8,
    calls: Arc<AtomicUsize>,
    id: &'static str,
}
impl BinaryDiffPlugin for Plugin {
    fn id(&self) -> &str {
        self.id
    }
    fn extensions(&self) -> &[&str] {
        &["pluginbin"]
    }
    fn diff(
        &self,
        old: &[u8],
        new: &[u8],
    ) -> Result<Option<Vec<EditAction>>, Box<dyn std::error::Error + Send + Sync>> {
        assert_eq!(old, [0xff]);
        assert_eq!(new, [0xfe]);
        self.calls.fetch_add(1, Ordering::Relaxed);
        match self.mode {
            0 => Err(std::io::Error::other("unsupported image header").into()),
            1 => Ok(Some(Vec::new())),
            _ => {
                let mut builder = TreeBuilder::new();
                let root = builder.push(NodeSpec::new("image")).unwrap();
                let node = builder.finish(root).unwrap().root_ref();
                Ok(Some(vec![EditAction::Update {
                    node,
                    detail: UpdateDetail::ValueChanged {
                        from: Some("1x1".to_owned()),
                        to: Some("2x2".to_owned()),
                    },
                    context: Vec::new(),
                }]))
            }
        }
    }
}
#[test]
fn binary_plugins_try_errors_empty_results_then_first_real_answer() {
    let calls = Arc::new(AtomicUsize::new(0));
    for (mode, id) in [
        (0, "routing-error"),
        (1, "routing-empty"),
        (2, "routing-result"),
    ] {
        register_binary_plugin(Arc::new(Plugin {
            mode,
            calls: Arc::clone(&calls),
            id,
        }));
    }
    let result = diff_with_tier(
        &[0xff],
        &[0xfe],
        "a.pluginbin",
        "a.pluginbin",
        SourcePresence::default(),
    );
    assert_eq!(result.tier, Tier::Binary);
    assert_eq!(result.changes[0].node().kind, "image");
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    for id in ["routing-error", "routing-empty", "routing-result"] {
        assert!(unregister_binary_plugin(id));
    }
}
