//! Legacy-compatible two-stream FNV hashing of UTF-16 code units.

const FNV_PRIME: u32 = 0x0100_0193;
const MIX_PRIME: u32 = 0x85eb_ca6b;
const SEED_A: u32 = 0x811c_9dc5;
const SEED_B: u32 = 0x0100_0193;
const LOW_MASK: u64 = 0x1f_ffff;

fn hash_string(mut seed: u32, text: &str) -> u32 {
    for unit in text.encode_utf16() {
        seed = (seed ^ u32::from(unit)).wrapping_mul(FNV_PRIME);
    }
    seed
}

const fn fold(a: u32, b: u32) -> u64 {
    ((a as u64) << 21) + ((b as u64) & LOW_MASK)
}

/// Hash text exactly as the original JavaScript implementation did, including
/// astral characters represented as UTF-16 surrogate pairs.
#[must_use]
pub fn hash_text(text: &str) -> u64 {
    fold(hash_string(SEED_A, text), hash_string(SEED_B, text))
}

fn mix(seed: u32, word: u32, prime: u32) -> u32 {
    let mixed = (seed ^ word).wrapping_mul(prime);
    mixed ^ (mixed >> 15)
}

pub(crate) struct Hasher {
    a: u32,
    b: u32,
}

impl Hasher {
    pub(crate) fn new(kind: &str) -> Self {
        Self {
            a: hash_string(SEED_A, kind),
            b: hash_string(SEED_B, kind),
        }
    }

    pub(crate) fn text(&mut self, value: &str) {
        self.a = hash_string(self.a, value);
        self.b = hash_string(self.b, value);
    }

    pub(crate) fn child(&mut self, hash: u64) {
        // A folded hash carries exactly 32 high bits and 21 low bits.
        let high = u32::try_from(hash >> 21).expect("folded hash high word fits u32");
        let low = u32::try_from(hash & LOW_MASK).expect("folded hash low word fits u32");
        self.a = mix(mix(self.a, high, FNV_PRIME), low, MIX_PRIME);
        self.b = mix(mix(self.b, low, FNV_PRIME), high, MIX_PRIME);
    }

    pub(crate) fn finish(self) -> u64 {
        fold(self.a, self.b)
    }
}
