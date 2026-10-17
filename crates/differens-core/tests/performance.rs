use differens_core::{MatchOptions, NodeSpec, Tree, TreeBuilder, diff_trees};
use std::{hint::black_box, sync::Arc, time::Instant};

fn repeated(width: usize, changed: Option<usize>, append: bool) -> Arc<Tree> {
    let mut builder = TreeBuilder::with_capacity(width * 2 + 3);
    let mut children = Vec::with_capacity(width + usize::from(append));
    for index in 0..width {
        let mut leaf = NodeSpec::new("token");
        leaf.value = Some(
            if changed == Some(index) {
                "changed"
            } else {
                "same"
            }
            .to_owned(),
        );
        let leaf = builder.push(leaf).unwrap();
        let mut block = NodeSpec::new("block");
        block.children.push(leaf);
        children.push(builder.push(block).unwrap());
    }
    if append {
        children.push(builder.push(NodeSpec::new("new_declaration")).unwrap());
    }
    let mut root = NodeSpec::new("root");
    root.children = children;
    let root = builder.push(root).unwrap();
    builder.finish(root).unwrap()
}

#[test]
#[ignore = "manual release benchmark; prints matching time without parsing/construction"]
fn repeated_container_matching() {
    for width in [1_000, 5_000, 10_000] {
        let old = repeated(width, None, false);
        for (name, new) in [
            ("append", repeated(width, None, true)),
            ("value", repeated(width, Some(width / 2), false)),
        ] {
            let mut times = Vec::new();
            for _ in 0..5 {
                let start = Instant::now();
                let result = black_box(diff_trees(
                    black_box(&old),
                    black_box(&new),
                    MatchOptions::default(),
                ));
                times.push(start.elapsed().as_secs_f64() * 1000.0);
                black_box(result);
            }
            times.sort_by(f64::total_cmp);
            println!("repeated {name} width={width} median_ms={:.3}", times[2]);
        }
    }
}

#[test]
fn repetitive_containers_keep_expected_insertions_and_updates() {
    let old = repeated(100, None, false);
    let appended = repeated(100, None, true);
    let result = diff_trees(&old, &appended, MatchOptions::default());
    assert_eq!(result.changes.len(), 1);
    assert_eq!(result.changes[0].action_type(), "Insert");
    let changed = repeated(100, Some(50), false);
    let result = diff_trees(&old, &changed, MatchOptions::default());
    assert_eq!(
        result
            .changes
            .iter()
            .filter(|change| change.action_type() == "Update")
            .count(),
        1
    );
    assert_eq!(
        result
            .changes
            .iter()
            .filter(|change| change.action_type() == "Move")
            .count(),
        1
    );
}

fn anchored_chain(depth: usize, value: &str) -> Arc<Tree> {
    let mut builder = TreeBuilder::with_capacity(depth + 2);
    let mut anchor = NodeSpec::new("anchor");
    anchor.value = Some("unchanged".to_owned());
    let anchor = builder.push(anchor).unwrap();
    let mut changed = NodeSpec::new("changed");
    changed.value = Some(value.to_owned());
    let changed = builder.push(changed).unwrap();
    let mut base = NodeSpec::new("box");
    base.children = vec![anchor, changed];
    let mut root = builder.push(base).unwrap();
    for _ in 1..depth {
        let mut parent = NodeSpec::new("box");
        parent.children.push(root);
        root = builder.push(parent).unwrap();
    }
    builder.finish(root).unwrap()
}

#[test]
fn anchored_deep_value_edit_remains_one_update() {
    let old = anchored_chain(5_000, "old");
    let new = anchored_chain(5_000, "new");
    let result = diff_trees(&old, &new, MatchOptions::default());
    assert_eq!(result.changes.len(), 1);
    assert_eq!(result.changes[0].action_type(), "Update");
}

#[test]
#[ignore = "manual release benchmark; deep matched-anchor bottom-up behavior"]
fn anchored_deep_matching() {
    for depth in [500, 2_000, 5_000] {
        let old = anchored_chain(depth, "old");
        let new = anchored_chain(depth, "new");
        let mut samples = Vec::new();
        for _ in 0..3 {
            let start = Instant::now();
            let result = diff_trees(&old, &new, MatchOptions::default());
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(result.changes.len(), 1);
        }
        samples.sort_by(f64::total_cmp);
        println!("anchored_chain depth={depth} median_ms={:.3}", samples[1]);
    }
}
