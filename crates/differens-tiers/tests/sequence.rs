use differens_tiers::sequence::{
    HunkKind, SeqKind, diff_lines, diff_sequences, diff_words, myers_split,
};
fn reference(a: &[&str], b: &[&str]) -> usize {
    let mut dp = vec![0; b.len() + 1];
    for left in a {
        let mut diagonal = 0;
        for (j, right) in b.iter().enumerate() {
            let old = dp[j + 1];
            dp[j + 1] = if left == right {
                diagonal + 1
            } else {
                dp[j].max(dp[j + 1])
            };
            diagonal = old;
        }
    }
    dp[b.len()]
}
#[test]
fn myers_matches_reference_and_reconstructs() {
    let mut seed = 0xdead_beef_u32;
    let mut random = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as usize
    };
    let alphabet = ["a", "b", "c", "d"];
    for _ in 0..1000 {
        let a: Vec<_> = (0..random() % 40).map(|_| alphabet[random() % 4]).collect();
        let b: Vec<_> = (0..random() % 40).map(|_| alphabet[random() % 4]).collect();
        let mut ops = Vec::new();
        assert!(myers_split(&a, &b, usize::MAX, &mut ops), "{a:?} -> {b:?}");
        assert_eq!(
            ops.iter().filter(|op| op.kind == SeqKind::Equal).count(),
            reference(&a, &b)
        );
        assert_eq!(
            ops.iter()
                .filter(|op| op.kind != SeqKind::Insert)
                .map(|op| op.text.as_str())
                .collect::<Vec<_>>(),
            a
        );
        assert_eq!(
            ops.iter()
                .filter(|op| op.kind != SeqKind::Delete)
                .map(|op| op.text.as_str())
                .collect::<Vec<_>>(),
            b
        );
    }
}
#[test]
fn head_tail_trimming_keeps_large_edits_small() {
    let old = (0..50_000).map(|i| format!("line{i}")).collect::<Vec<_>>();
    let mut new = old.clone();
    new[25_000] = "CHANGED".to_owned();
    let hunks = diff_lines(&old.join("\n"), &new.join("\n"));
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Update);
    assert_eq!(hunks[0].new_text.as_deref(), Some("CHANGED"));
    assert_eq!(
        diff_words("hello world", "hello  world")[0]
            .old_text
            .as_deref(),
        Some(" ")
    );
}
#[test]
fn dense_large_fallback_reconstructs() {
    let a = (0..40_000).map(|i| format!("line{i}")).collect::<Vec<_>>();
    let mut b = a
        .iter()
        .enumerate()
        .map(|(i, line)| {
            if i % 2 == 0 {
                format!("{line} EDITED")
            } else {
                line.clone()
            }
        })
        .collect::<Vec<_>>();
    b.extend(["trailer one".to_owned(), "trailer two".to_owned()]);
    let aa: Vec<_> = a.iter().map(String::as_str).collect();
    let bb: Vec<_> = b.iter().map(String::as_str).collect();
    let ops = diff_sequences(&aa, &bb, "\n");
    assert_eq!(
        ops.iter()
            .filter(|op| op.kind != SeqKind::Insert)
            .map(|op| op.text.as_str())
            .collect::<Vec<_>>(),
        aa
    );
    assert_eq!(
        ops.iter()
            .filter(|op| op.kind != SeqKind::Delete)
            .map(|op| op.text.as_str())
            .collect::<Vec<_>>(),
        bb
    );
}

#[test]
fn internal_equal_runs_and_hunk_pairing_preserve_exact_edits() {
    use differens_tiers::sequence::{SeqOp, merge_hunks};
    let hunks = diff_lines("A\nmiddle\nZ", "B\nmiddle\nY");
    assert_eq!(hunks.len(), 2);
    assert!(hunks.iter().all(|hunk| hunk.kind == HunkKind::Update));
    assert_eq!(hunks[0].old_text.as_deref(), Some("A"));
    assert_eq!(hunks[1].old_text.as_deref(), Some("Z"));
    let hunks = merge_hunks(vec![
        SeqOp {
            kind: SeqKind::Insert,
            text: "new".to_owned(),
        },
        SeqOp {
            kind: SeqKind::Delete,
            text: "old".to_owned(),
        },
    ]);
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_text.as_deref(), Some("old"));
    assert_eq!(hunks[0].new_text.as_deref(), Some("new"));
    let hunks = diff_lines("alpha\nbeta\ngamma", "one\ntwo\nthree");
    assert_eq!(
        hunks.iter().map(|hunk| hunk.kind).collect::<Vec<_>>(),
        [
            HunkKind::Delete,
            HunkKind::Delete,
            HunkKind::Update,
            HunkKind::Insert,
            HunkKind::Insert
        ]
    );
}
#[test]
fn large_low_density_myers_and_whole_rewrites_remain_precise() {
    let old = (0..3000).map(|i| format!("line{i}")).collect::<Vec<_>>();
    let mut new = old.clone();
    new[0] = "new first".to_owned();
    new[2999] = "new last".to_owned();
    let hunks = diff_lines(&old.join("\n"), &new.join("\n"));
    assert_eq!(hunks.len(), 2);
    assert!(hunks.iter().all(|hunk| hunk.kind == HunkKind::Update));
    let rewrite = (0..3000).map(|i| format!("other{i}")).collect::<Vec<_>>();
    let hunks = diff_lines(&old.join("\n"), &rewrite.join("\n"));
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_text.as_deref(), Some(old.join("\n").as_str()));
    assert_eq!(
        hunks[0].new_text.as_deref(),
        Some(rewrite.join("\n").as_str())
    );
    let reversed = old.iter().rev().map(String::as_str).collect::<Vec<_>>();
    let source = old.iter().map(String::as_str).collect::<Vec<_>>();
    let ops = diff_sequences(&source, &reversed, "\n");
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0].kind, SeqKind::Delete);
    assert_eq!(ops[1].kind, SeqKind::Insert);
}
#[test]
fn dense_fallback_preserves_trailing_deletions() {
    let old = (0..4000).map(|i| format!("line{i}")).collect::<Vec<_>>();
    let new = old[..3998]
        .iter()
        .enumerate()
        .map(|(i, line)| {
            if i % 2 == 0 {
                format!("{line} edit")
            } else {
                line.clone()
            }
        })
        .collect::<Vec<_>>();
    let aa = old.iter().map(String::as_str).collect::<Vec<_>>();
    let bb = new.iter().map(String::as_str).collect::<Vec<_>>();
    let ops = diff_sequences(&aa, &bb, "\n");
    assert_eq!(
        ops.iter()
            .filter(|op| op.kind != SeqKind::Insert)
            .map(|op| op.text.as_str())
            .collect::<Vec<_>>(),
        aa
    );
    assert_eq!(
        ops.iter()
            .filter(|op| op.kind != SeqKind::Delete)
            .map(|op| op.text.as_str())
            .collect::<Vec<_>>(),
        bb
    );
}
