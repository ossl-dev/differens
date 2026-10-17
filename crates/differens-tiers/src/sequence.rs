//! Bounded exact LCS and linear-space Myers sequence alignment.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeqKind {
    Insert,
    Delete,
    Equal,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SeqOp {
    pub kind: SeqKind,
    pub text: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HunkKind {
    Insert,
    Delete,
    Update,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HunkDiff {
    pub kind: HunkKind,
    pub text: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}
const TABLE_MAX: usize = 2_000;
const OPS_BUDGET: usize = 2_000_000;
fn op(kind: SeqKind, text: &str) -> SeqOp {
    SeqOp {
        kind,
        text: text.to_owned(),
    }
}

#[must_use]
pub fn diff_sequences(a: &[&str], b: &[&str], join: &str) -> Vec<SeqOp> {
    let shortest = a.len().min(b.len());
    let mut head = 0;
    while head < shortest && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < shortest - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    let a = &a[head..a.len() - tail];
    let b = &b[head..b.len() - tail];
    if a.len() <= TABLE_MAX && b.len() <= TABLE_MAX {
        return lcs(a, b);
    }
    let seen: HashSet<_> = a.iter().copied().collect();
    if !b.iter().any(|token| seen.contains(token)) {
        return vec![
            op(SeqKind::Delete, &a.join(join)),
            op(SeqKind::Insert, &b.join(join)),
        ];
    }
    let mut ops = Vec::new();
    if myers_split(a, b, OPS_BUDGET, &mut ops) {
        ops
    } else {
        anchored_fallback(a, b, join)
    }
}
fn lcs(a: &[&str], b: &[&str]) -> Vec<SeqOp> {
    let width = b.len() + 1;
    let mut dp = vec![0_u16; (a.len() + 1) * width];
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            dp[i * width + j] = if a[i - 1] == b[j - 1] {
                dp[(i - 1) * width + j - 1] + 1
            } else {
                dp[(i - 1) * width + j].max(dp[i * width + j - 1])
            };
        }
    }
    let (mut i, mut j) = (a.len(), b.len());
    let mut ops = Vec::new();
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && a[i - 1] == b[j - 1] {
            ops.push(op(SeqKind::Equal, a[i - 1]));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i * width + j - 1] >= dp[(i - 1) * width + j]) {
            ops.push(op(SeqKind::Insert, b[j - 1]));
            j -= 1;
        } else {
            ops.push(op(SeqKind::Delete, a[i - 1]));
            i -= 1;
        }
    }
    ops.reverse();
    ops
}

/// Append a shortest alignment, or return false when shared work budget expires.
/// On false, callers must discard the partial output.
pub fn myers_split(a: &[&str], b: &[&str], mut budget: usize, ops: &mut Vec<SeqOp>) -> bool {
    enum Job {
        Region(usize, usize, usize, usize),
        Equal(usize, usize),
    }
    let mut jobs = vec![Job::Region(0, a.len(), 0, b.len())];
    while let Some(job) = jobs.pop() {
        let Job::Region(mut lo_a, mut hi_a, mut lo_b, mut hi_b) = job else {
            if let Job::Equal(lo, hi) = job {
                ops.extend(a[lo..hi].iter().map(|text| op(SeqKind::Equal, text)));
            }
            continue;
        };
        while lo_a < hi_a && lo_b < hi_b && a[lo_a] == b[lo_b] {
            ops.push(op(SeqKind::Equal, a[lo_a]));
            lo_a += 1;
            lo_b += 1;
        }
        let suffix_end = hi_a;
        while hi_a > lo_a && hi_b > lo_b && a[hi_a - 1] == b[hi_b - 1] {
            hi_a -= 1;
            hi_b -= 1;
        }
        if hi_a < suffix_end {
            jobs.push(Job::Equal(hi_a, suffix_end));
        }
        if lo_a == hi_a {
            ops.extend(b[lo_b..hi_b].iter().map(|text| op(SeqKind::Insert, text)));
            continue;
        }
        if lo_b == hi_b {
            ops.extend(a[lo_a..hi_a].iter().map(|text| op(SeqKind::Delete, text)));
            continue;
        }
        let Some((x, y)) = bisect(&a[lo_a..hi_a], &b[lo_b..hi_b], &mut budget) else {
            return false;
        };
        if (x == 0 && y == 0) || (x == hi_a - lo_a && y == hi_b - lo_b) {
            return false;
        }
        jobs.push(Job::Region(lo_a + x, hi_a, lo_b + y, hi_b));
        jobs.push(Job::Region(lo_a, lo_a + x, lo_b, lo_b + y));
    }
    true
}
fn bisect(left: &[&str], right: &[&str], budget: &mut usize) -> Option<(usize, usize)> {
    let left_len = isize::try_from(left.len()).ok()?;
    let right_len = isize::try_from(right.len()).ok()?;
    let half = (left_len + right_len + 1) / 2;
    let offset = half + 1;
    let len = usize::try_from(2 * half + 3).ok()?;
    let mut forward = vec![-1_isize; len];
    let mut reverse = vec![-1_isize; len];
    let index =
        |k: isize| usize::try_from(offset + k).expect("diagonal is inside allocated bounds");
    forward[index(1)] = 0;
    reverse[index(1)] = 0;
    let delta = left_len - right_len;
    let odd = delta % 2 != 0;
    let (mut fstart, mut fend, mut rstart, mut rend) = (0, 0, 0, 0);
    for distance in 0..=half {
        let cost = left.len() + right.len();
        if *budget < cost {
            return None;
        }
        *budget -= cost;
        let mut k = -distance + fstart;
        while k <= distance - fend {
            let mut x = if k == -distance
                || (k != distance && forward[index(k - 1)] < forward[index(k + 1)])
            {
                forward[index(k + 1)]
            } else {
                forward[index(k - 1)] + 1
            };
            let mut y = x - k;
            while x < left_len
                && y < right_len
                && x >= 0
                && y >= 0
                && left[usize::try_from(x).ok()?] == right[usize::try_from(y).ok()?]
            {
                x += 1;
                y += 1;
            }
            forward[index(k)] = x;
            if x > left_len {
                fend += 2;
            } else if y > right_len {
                fstart += 2;
            } else if odd {
                let rk = delta - k;
                if rk >= -half
                    && rk <= half
                    && reverse[index(rk)] != -1
                    && x >= left_len - reverse[index(rk)]
                {
                    return Some((usize::try_from(x).ok()?, usize::try_from(y).ok()?));
                }
            }
            k += 2;
        }
        let mut k = -distance + rstart;
        while k <= distance - rend {
            let mut x = if k == -distance
                || (k != distance && reverse[index(k - 1)] < reverse[index(k + 1)])
            {
                reverse[index(k + 1)]
            } else {
                reverse[index(k - 1)] + 1
            };
            let mut y = x - k;
            while x < left_len
                && y < right_len
                && x >= 0
                && y >= 0
                && left[usize::try_from(left_len - 1 - x).ok()?]
                    == right[usize::try_from(right_len - 1 - y).ok()?]
            {
                x += 1;
                y += 1;
            }
            reverse[index(k)] = x;
            if x > left_len {
                rend += 2;
            } else if y > right_len {
                rstart += 2;
            } else if !odd {
                let fk = delta - k;
                if fk >= -half
                    && fk <= half
                    && forward[index(fk)] != -1
                    && forward[index(fk)] >= left_len - x
                {
                    let fx = forward[index(fk)];
                    return Some((usize::try_from(fx).ok()?, usize::try_from(fx - fk).ok()?));
                }
            }
            k += 2;
        }
    }
    None
}
// When exact alignment exhausts its budget, unique unchanged lines still make
// reliable anchors. Their increasing subsequence avoids pairing every line
// after an insertion with the wrong neighbor. Gaps keep the bounded positional
// fallback; this path deliberately makes no global minimality claim.
fn anchored_fallback(a: &[&str], b: &[&str], join: &str) -> Vec<SeqOp> {
    fn unique_positions<'a>(tokens: &[&'a str]) -> HashMap<&'a str, Option<usize>> {
        let mut positions = HashMap::with_capacity(tokens.len());
        for (index, &token) in tokens.iter().enumerate() {
            positions
                .entry(token)
                .and_modify(|position| *position = None)
                .or_insert(Some(index));
        }
        positions
    }
    let old = unique_positions(a);
    let new = unique_positions(b);
    let candidates: Vec<_> = a
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            (old.get(token) == Some(&Some(index)))
                .then(|| {
                    new.get(token)
                        .copied()
                        .flatten()
                        .map(|other| (index, other))
                })
                .flatten()
        })
        .collect();
    let mut previous = vec![usize::MAX; candidates.len()];
    let mut tails: Vec<usize> = Vec::new();
    for (index, &(_, position)) in candidates.iter().enumerate() {
        let slot = tails.partition_point(|&tail| candidates[tail].1 < position);
        if slot != 0 {
            previous[index] = tails[slot - 1];
        }
        if slot == tails.len() {
            tails.push(index);
        } else {
            tails[slot] = index;
        }
    }
    if tails.len() < 2 {
        return zip_fallback(a, b, join);
    }
    let mut anchors = Vec::with_capacity(tails.len());
    let mut cursor = *tails.last().expect("at least two unique anchors");
    while cursor != usize::MAX {
        anchors.push(candidates[cursor]);
        cursor = previous[cursor];
    }
    anchors.reverse();
    let mut ops = Vec::new();
    let (mut left, mut right) = (0, 0);
    for (x, y) in anchors {
        ops.extend(zip_fallback(&a[left..x], &b[right..y], join));
        ops.push(op(SeqKind::Equal, a[x]));
        left = x + 1;
        right = y + 1;
    }
    ops.extend(zip_fallback(&a[left..], &b[right..], join));
    ops
}

fn zip_fallback(a: &[&str], b: &[&str], join: &str) -> Vec<SeqOp> {
    let mut ops = Vec::new();
    let mut equals = 0;
    for i in 0..a.len().max(b.len()) {
        match (a.get(i), b.get(i)) {
            (Some(a), Some(b)) if a == b => {
                ops.push(op(SeqKind::Equal, a));
                equals += 1;
            }
            (Some(a), Some(b)) => {
                ops.push(op(SeqKind::Delete, a));
                ops.push(op(SeqKind::Insert, b));
            }
            (Some(a), None) => ops.push(op(SeqKind::Delete, a)),
            (None, Some(b)) => ops.push(op(SeqKind::Insert, b)),
            _ => {}
        }
    }
    if equals == 0 && !a.is_empty() && !b.is_empty() {
        vec![
            op(SeqKind::Delete, &a.join(join)),
            op(SeqKind::Insert, &b.join(join)),
        ]
    } else {
        ops
    }
}
#[must_use]
pub fn merge_hunks(ops: Vec<SeqOp>) -> Vec<HunkDiff> {
    let mut hunks = Vec::new();
    let mut ops = ops.into_iter().peekable();
    while let Some(current) = ops.next() {
        if ops.peek().is_some_and(|next| {
            matches!(
                (current.kind, next.kind),
                (SeqKind::Delete, SeqKind::Insert) | (SeqKind::Insert, SeqKind::Delete)
            )
        }) {
            let Some(next) = ops.next() else {
                break;
            };
            let (old, new) = if current.kind == SeqKind::Delete {
                (current.text, next.text)
            } else {
                (next.text, current.text)
            };
            hunks.push(HunkDiff {
                kind: HunkKind::Update,
                text: new.clone(),
                old_text: Some(old),
                new_text: Some(new),
            });
        } else if current.kind != SeqKind::Equal {
            hunks.push(HunkDiff {
                kind: if current.kind == SeqKind::Insert {
                    HunkKind::Insert
                } else {
                    HunkKind::Delete
                },
                text: current.text,
                old_text: None,
                new_text: None,
            });
        }
    }
    hunks
}
#[must_use]
pub fn diff_lines(old: &str, new: &str) -> Vec<HunkDiff> {
    merge_hunks(diff_sequences(
        &old.split('\n').collect::<Vec<_>>(),
        &new.split('\n').collect::<Vec<_>>(),
        "\n",
    ))
}
fn tokenize(source: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut whitespace = None;
    for (i, ch) in source.char_indices() {
        let next = ch.is_whitespace();
        if whitespace.is_some_and(|previous| previous != next) {
            out.push(&source[start..i]);
            start = i;
        }
        whitespace = Some(next);
    }
    if start < source.len() {
        out.push(&source[start..]);
    }
    out
}
#[must_use]
pub fn diff_words(old: &str, new: &str) -> Vec<HunkDiff> {
    merge_hunks(diff_sequences(&tokenize(old), &tokenize(new), ""))
}
