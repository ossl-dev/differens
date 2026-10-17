use std::collections::HashMap;

use crate::{Tree, tree::subtrees_equal};

const MAX_ALIGN: usize = 64;
const MAX_CANDIDATES: usize = 4;

pub(crate) struct Matching {
    pub(crate) old: Vec<Option<usize>>,
    pub(crate) new: Vec<Option<usize>>,
}

impl Matching {
    pub(crate) fn new(old: usize, new: usize) -> Self {
        Self {
            old: vec![None; old],
            new: vec![None; new],
        }
    }

    pub(crate) fn link(&mut self, i: usize, j: usize) {
        if self.old[i].is_none() && self.new[j].is_none() {
            self.old[i] = Some(j);
            self.new[j] = Some(i);
        }
    }
}

pub(crate) fn top_down(old: &Tree, new: &Tree, matching: &mut Matching, min_height: usize) {
    let height = old.nodes[old.root().0]
        .height
        .max(new.nodes[new.root().0].height);
    let mut old_buckets = vec![Vec::new(); height + 1];
    let mut new_buckets = vec![Vec::new(); height + 1];
    old_buckets[old.nodes[old.root().0].height].push(old.root().0);
    new_buckets[new.nodes[new.root().0].height].push(new.root().0);
    let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();

    for h in (1..=height).rev() {
        let a = std::mem::take(&mut old_buckets[h]);
        let b = std::mem::take(&mut new_buckets[h]);
        if !a.is_empty() && !b.is_empty() {
            by_hash.clear();
            for &j in &b {
                if matching.new[j].is_none() {
                    by_hash
                        .entry(new.nodes[j].content_hash)
                        .or_default()
                        .push(j);
                }
            }
            for &i in &a {
                if matching.old[i].is_some() {
                    continue;
                }
                let Some(candidates) = by_hash.get(&old.nodes[i].content_hash) else {
                    continue;
                };
                if h < min_height && candidates.len() > MAX_ALIGN {
                    continue;
                }
                let mut best = None;
                let mut best_score = f64::NEG_INFINITY;
                let mut ambiguous = false;
                for &j in candidates {
                    if matching.new[j].is_some() || !subtrees_equal(old, i, new, j, false) {
                        continue;
                    }
                    let score = affinity(old, new, matching, i, j);
                    ambiguous |= best.is_some();
                    if score > best_score {
                        best = Some(j);
                        best_score = score;
                    }
                }
                let Some(j) = best else {
                    continue;
                };
                if ambiguous && h < min_height {
                    match (old.nodes[i].parent, new.nodes[j].parent) {
                        (Some(pi), Some(pj)) if matching.old[pi.0] == Some(pj.0) => {}
                        _ => continue,
                    }
                }
                let old_start = old.lo(i);
                let new_start = new.lo(j);
                for offset in 0..old.nodes[i].size {
                    matching.link(old_start + offset, new_start + offset);
                }
            }
        }
        for i in a {
            if matching.old[i].is_none() {
                for child in old.nodes[i].children.iter().rev() {
                    old_buckets[old.nodes[child.0].height].push(child.0);
                }
            }
        }
        for j in b {
            if matching.new[j].is_none() {
                for child in new.nodes[j].children.iter().rev() {
                    new_buckets[new.nodes[child.0].height].push(child.0);
                }
            }
        }
    }
}

fn affinity(old: &Tree, new: &Tree, matching: &Matching, i: usize, j: usize) -> f64 {
    let mut score = 0.0;
    if let (Some(pi), Some(pj)) = (old.nodes[i].parent, new.nodes[j].parent) {
        if matching.old[pi.0] == Some(pj.0) {
            score += 8.0;
        } else if old.nodes[pi.0].kind == new.nodes[pj.0].kind {
            score += 1.0;
        }
    }
    let distance = u32::try_from(old.nodes[i].position.abs_diff(new.nodes[j].position).min(8))
        .expect("distance is at most 8");
    score - f64::from(distance) * 0.1
}

/// Intern ancestor paths jointly so named deep trees do not copy every prefix.
pub(crate) fn named_containers(old: &Tree, new: &Tree, matching: &mut Matching) {
    type PathKey<'a> = (usize, &'a str, &'a str);
    fn paths<'a>(tree: &'a Tree, intern: &mut HashMap<PathKey<'a>, usize>) -> Vec<usize> {
        let mut result = vec![0; tree.len()];
        for i in (0..tree.len()).rev() {
            let parent = tree.nodes[i].parent.map_or(0, |p| result[p.0]);
            result[i] =
                if let Some(label) = tree.nodes[i].label.as_deref().filter(|s| !s.is_empty()) {
                    let next_id = intern.len() + 1;
                    *intern
                        .entry((parent, &tree.nodes[i].kind, label))
                        .or_insert(next_id)
                } else {
                    parent
                };
        }
        result
    }
    let mut intern = HashMap::new();
    let old_paths = paths(old, &mut intern);
    let new_paths = paths(new, &mut intern);
    let mut candidates: HashMap<usize, Option<usize>> = HashMap::new();
    for (j, node) in new.nodes.iter().enumerate() {
        if matching.new[j].is_some()
            || node.label.as_deref().is_none_or(str::is_empty)
            || node.children.is_empty()
        {
            continue;
        }
        candidates
            .entry(new_paths[j])
            .and_modify(|entry| *entry = None)
            .or_insert(Some(j));
    }
    for (i, node) in old.nodes.iter().enumerate() {
        if matching.old[i].is_some()
            || node.label.as_deref().is_none_or(str::is_empty)
            || node.children.is_empty()
        {
            continue;
        }
        if let Some(Some(j)) = candidates.get(&old_paths[i]) {
            matching.link(i, *j);
        }
    }
}

pub(crate) fn bottom_up(old: &Tree, new: &Tree, matching: &mut Matching, ratio: f64) {
    let mut stamp = vec![usize::MAX; new.len()];
    let mut common = vec![0_usize; new.len()];
    let mut candidates = Vec::new();
    // Earlier descendants' mappings are final in ascending postorder. Prefix
    // counts skip empty candidate scans in deep, wholly rewritten trees.
    let mut matched_prefix = vec![0_usize; old.len() + 1];
    for i in 0..old.len() {
        if matching.old[i].is_none()
            && old.nodes[i].size > 1
            && matched_prefix[i] > matched_prefix[old.lo(i)]
        {
            candidates.clear();
            for d in old.lo(i)..i {
                let Some(j) = matching.old[d] else {
                    continue;
                };
                let mut ancestor = new.nodes[j].parent;
                while let Some(a) = ancestor {
                    if matching.new[a.0].is_some() {
                        break;
                    }
                    if new.nodes[a.0].kind == old.nodes[i].kind {
                        if stamp[a.0] != i {
                            stamp[a.0] = i;
                            common[a.0] = 0;
                            candidates.push(a.0);
                        }
                        common[a.0] += 1;
                    }
                    ancestor = new.nodes[a.0].parent;
                }
            }
            if candidates.len() > MAX_CANDIDATES {
                // Stable sorting preserves the original deterministic tie rule.
                candidates.sort_by_key(|&candidate| std::cmp::Reverse(common[candidate]));
                candidates.truncate(MAX_CANDIDATES);
            }
            let mut best = None;
            let mut best_dice = 0.0;
            for &candidate in &candidates {
                let denominator = old.nodes[i].size - 1 + new.nodes[candidate].size - 1;
                let start = new.lo(candidate);
                let count = (old.lo(i)..i)
                    .filter(|&d| matching.old[d].is_some_and(|j| j >= start && j < candidate))
                    .count();
                #[allow(clippy::cast_precision_loss)]
                // Counts fit addressable memory; only relative scores need floating point.
                let dice = 2.0 * count as f64 / denominator as f64;
                if dice > best_dice {
                    best = Some(candidate);
                    best_dice = dice;
                }
            }
            if let Some(candidate) = best {
                if (old.nodes[i].parent.is_none() && best_dice > 0.0) || best_dice >= ratio {
                    matching.link(i, candidate);
                }
            }
        }
        matched_prefix[i + 1] = matched_prefix[i] + usize::from(matching.old[i].is_some());
    }
}

fn unmatched_leaves(tree: &Tree, links: &[Option<usize>], parent: usize) -> Vec<usize> {
    tree.nodes[parent]
        .children
        .iter()
        .filter_map(|child| {
            (tree.nodes[child.0].size == 1 && links[child.0].is_none()).then_some(child.0)
        })
        .collect()
}

pub(crate) fn recover_leaves(old: &Tree, new: &Tree, matching: &mut Matching) {
    for i in 0..old.len() {
        let Some(j) = matching.old[i] else {
            continue;
        };
        if old.nodes[i].size == 1 {
            continue;
        }
        let old_leaves = unmatched_leaves(old, &matching.old, i);
        if old_leaves.is_empty() {
            continue;
        }
        let new_leaves = unmatched_leaves(new, &matching.new, j);
        if new_leaves.is_empty() {
            continue;
        }
        if old_leaves.len() > MAX_ALIGN || new_leaves.len() > MAX_ALIGN {
            for (&x, &y) in old_leaves.iter().zip(&new_leaves) {
                if old.nodes[x].kind == new.nodes[y].kind {
                    matching.link(x, y);
                }
            }
            continue;
        }
        let width = new_leaves.len() + 1;
        let mut table = vec![0_usize; (old_leaves.len() + 1) * width];
        for x in (0..old_leaves.len()).rev() {
            for y in (0..new_leaves.len()).rev() {
                table[x * width + y] =
                    if old.nodes[old_leaves[x]].kind == new.nodes[new_leaves[y]].kind {
                        table[(x + 1) * width + y + 1] + 1
                    } else {
                        table[(x + 1) * width + y].max(table[x * width + y + 1])
                    };
            }
        }
        let (mut x, mut y) = (0, 0);
        while x < old_leaves.len() && y < new_leaves.len() {
            if old.nodes[old_leaves[x]].kind == new.nodes[new_leaves[y]].kind {
                matching.link(old_leaves[x], new_leaves[y]);
                x += 1;
                y += 1;
            } else if table[(x + 1) * width + y] >= table[x * width + y + 1] {
                x += 1;
            } else {
                y += 1;
            }
        }
    }
}

pub(crate) fn recover_containers(old: &Tree, new: &Tree, matching: &mut Matching) {
    let mut by_structure: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut by_parent: HashMap<(Option<crate::NodeId>, u64), Vec<usize>> = HashMap::new();
    let mut by_kind: HashMap<(Option<crate::NodeId>, &str), Vec<usize>> = HashMap::new();
    let mut old_kinds: HashMap<(Option<crate::NodeId>, &str), usize> = HashMap::new();
    let mut verified_structure = vec![None; old.len()];
    for node in &old.nodes {
        if node.label.as_deref().is_none_or(str::is_empty) && !node.children.is_empty() {
            *old_kinds.entry((node.parent, &node.kind)).or_default() += 1;
        }
    }
    for (j, node) in new.nodes.iter().enumerate() {
        if matching.new[j].is_some() || node.children.is_empty() {
            continue;
        }
        by_structure.entry(node.structure_hash).or_default().push(j);
        by_parent
            .entry((node.parent, node.structure_hash))
            .or_default()
            .push(j);
        if node.label.as_deref().is_none_or(str::is_empty) {
            by_kind
                .entry((node.parent, &node.kind))
                .or_default()
                .push(j);
        }
    }
    for i in (0..old.len()).rev() {
        let node = &old.nodes[i];
        if matching.old[i].is_some() || node.children.is_empty() {
            continue;
        }
        let partner = node.parent.and_then(|parent| matching.old[parent.0]);
        if let Some(partner) = partner {
            let eligible = node.match_by_kind
                && node.label.as_deref().is_none_or(str::is_empty)
                && old_kinds.get(&(node.parent, node.kind.as_str())) == Some(&1);
            if let Some(candidates) = by_kind
                .get(&(Some(crate::NodeId(partner)), node.kind.as_str()))
                .filter(|c| eligible && c.len() == 1)
            {
                if matching.new[candidates[0]].is_none() {
                    matching.link(i, candidates[0]);
                    continue;
                }
            }
        }
        let candidates = partner.map_or_else(
            || by_structure.get(&node.structure_hash),
            |parent| by_parent.get(&(Some(crate::NodeId(parent)), node.structure_hash)),
        );
        let Some(candidates) = candidates else {
            continue;
        };
        let mut only = None;
        for &j in candidates {
            if matching.new[j].is_some() {
                continue;
            }
            if verified_structure[i] != Some(j) {
                if !subtrees_equal(old, i, new, j, true) {
                    continue;
                }
                for offset in 0..node.size {
                    verified_structure[old.lo(i) + offset] = Some(new.lo(j) + offset);
                }
            }
            if only.is_some() {
                only = None;
                break;
            }
            only = Some(j);
        }
        if let Some(j) = only {
            matching.link(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Matching;

    #[test]
    fn links_are_bijective_and_never_overwritten() {
        let mut matching = Matching::new(3, 3);
        matching.link(0, 0);
        matching.link(0, 1);
        matching.link(1, 0);
        assert_eq!(matching.old, [Some(0), None, None]);
        assert_eq!(matching.new, [Some(0), None, None]);
    }
}
