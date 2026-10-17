//! Deterministic mutation corpus ported from the legacy tier pipeline tests.
use differens_tiers::{SourcePresence, Tier, TierDiffResult, diff_with_tier};
struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        // JavaScript's original generator uses arithmetic >> 17 here.
        let signed = i32::from_ne_bytes(self.0.to_ne_bytes()) >> 17;
        self.0 ^= u32::from_ne_bytes(signed.to_ne_bytes());
        self.0 ^= self.0 << 5;
        self.0
    }
    fn below(&mut self, limit: u32) -> usize {
        usize::try_from(u64::from(self.next()) * u64::from(limit) / u64::from(u32::MAX)).unwrap()
    }
}
fn run(old: &str, new: &str, path: &str) -> TierDiffResult {
    let result = diff_with_tier(
        old.as_bytes(),
        new.as_bytes(),
        path,
        path,
        SourcePresence::default(),
    );
    for change in &result.changes {
        assert_ne!(change.node().kind, "");
        assert!(matches!(
            change.action_type(),
            "Insert" | "Delete" | "Update" | "Move"
        ));
    }
    result
}
#[cfg(feature = "code")]
#[test]
fn sixty_seeded_typescript_mutations() {
    let mut random = Random(0x00c0_ffee);
    let base = "function alpha(): number { return 1; }\nfunction beta(): number { return 2; }\nfunction gamma(): number { return 3; }\nexport const answer = alpha() + beta() + gamma();\n";
    let lines = base.split('\n').map(str::to_owned).collect::<Vec<_>>();
    for trial in 0..60 {
        let mut mutated = lines.clone();
        let edits = 1 + random.below(3);
        for edit in 0..edits {
            let index = random.below(u32::try_from(mutated.len()).unwrap());
            let roll = random.below(10);
            if roll < 4 {
                mutated.remove(index);
            } else if roll < 7 {
                mutated.insert(index, format!("const injected{trial}_{edit} = {trial};"));
            } else {
                mutated[index] = format!(
                    "// fuzz edit {trial}_{edit}\nfunction fuzz{trial}_{edit}(): number {{ return {trial}; }}"
                );
            }
        }
        assert_eq!(run(base, &mutated.join("\n"), "a.ts").tier, Tier::Code);
    }
}
#[test]
fn sixty_seeded_json_mutations() {
    let mut random = Random(0x0bad_f00d);
    let mut base = serde_json::Map::new();
    for i in 0..20 {
        base.insert(format!("key{i}"), serde_json::Value::from(i));
    }
    let old = serde_json::to_string(&base).unwrap();
    for _ in 0..60 {
        let mut mutated = base.clone();
        let edits = 1 + random.below(5);
        for _ in 0..edits {
            let key = format!("key{}", random.below(25));
            if random.below(2) == 0 {
                mutated.insert(key, serde_json::Value::from(random.below(1000)));
            } else {
                mutated.shift_remove(&key);
            }
        }
        assert_eq!(
            run(
                &old,
                &serde_json::to_string(&mutated).unwrap(),
                "config.json"
            )
            .tier,
            Tier::Data
        );
    }
}
#[test]
fn sixty_seeded_malformed_json_pairs() {
    let mut random = Random(0x0005_1a7e);
    let fragments = ["{\"a\": 1", "{oops", "[1, 2", "", "}", "a: b"];
    for _ in 0..60 {
        let old = if random.below(2) == 0 {
            "{\"a\": 1, \"b\": 2}"
        } else {
            fragments[random.below(6)]
        };
        let new = if random.below(2) == 0 {
            "{\"a\": 1, \"b\": 2}"
        } else {
            fragments[random.below(6)]
        };
        run(old, new, "config.json");
    }
}
#[test]
fn arbitrary_unicode_markup_mutations_never_panic() {
    let fragments = [
        "é",
        "世界",
        "🙂",
        "<",
        "'",
        "\"",
        ">",
        "</div>",
        "<x:item data-x='雪'>",
        "<!--",
        "-->",
        "\n",
        "&amp;",
    ];
    let mut random = Random(0xabc0_1234);
    for _ in 0..120 {
        let old = (0..12)
            .map(|_| fragments[random.below(13)])
            .collect::<String>();
        let new = (0..12)
            .map(|_| fragments[random.below(13)])
            .collect::<String>();
        run(&old, &new, "a.html");
    }
}
