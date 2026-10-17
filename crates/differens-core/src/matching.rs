use std::collections::HashMap;

use crate::{Tree, tree::subtrees_equal};

const MAX_ALIGN: usize = 64;
const MAX_CANDIDATES: usize = 4;

#[derive(Default)]
struct PositionBucket {
    candidates: Vec<(usize, usize)>,
    first_unclaimed: usize,
}

#[derive(Default)]
struct HashBucket<'a> {
    candidates: Vec<usize>,
    first_unclaimed: usize,
    positions: Option<HashMap<(&'a str, usize), PositionBucket>>,
}

impl<'a> HashBucket<'a> {
    fn aligned_candidate(
        &mut self,
        old: &'a Tree,
        new: &'a Tree,
        matching: &Matching,
        id: usize,
    ) -> Option<usize> {
        let parent = old.nodes[id].parent?;
        if matching.old[parent.0].is_some() {
            return None;
        }
        let positions = self.positions.get_or_insert_with(|| {
            let mut positions: HashMap<(&str, usize), PositionBucket> = HashMap::new();
            for (ordinal, &candidate) in self.candidates.iter().enumerate() {
                if let Some(parent) = new.nodes[candidate].parent {
                    positions
                        .entry((&new.nodes[parent.0].kind, new.nodes[candidate].position))
                        .or_default()
                        .candidates
                        .push((ordinal, candidate));
                }
            }
            positions
        });
        let kind = old.nodes[parent.0].kind.as_str();
        let position = old.nodes[id].position;
        // With an unmatched parent, equal-parent-kind affinity is 1 and other
        // affinity is 0. An equal-kind distance below 8 beats all different
        // kinds and all larger distances. Bucket ordinal preserves every tie.
        for distance in 0..8 {
            let mut best = None;
            let locations = [
                position.checked_sub(distance),
                (distance != 0)
                    .then(|| position.checked_add(distance))
                    .flatten(),
            ];
            for location in locations.into_iter().flatten() {
                let Some(bucket) = positions.get_mut(&(kind, location)) else {
                    continue;
                };
                while bucket.first_unclaimed < bucket.candidates.len()
                    && matching.new[bucket.candidates[bucket.first_unclaimed].1].is_some()
                {
                    bucket.first_unclaimed += 1;
                }
                for &(ordinal, candidate) in &bucket.candidates[bucket.first_unclaimed..] {
                    if matching.new[candidate].is_none()
                        && subtrees_equal(old, id, new, candidate, false)
                    {
                        if best.is_none_or(|(previous, _)| ordinal < previous) {
                            best = Some((ordinal, candidate));
                        }
                        break;
                    }
                }
            }
            if let Some((_, candidate)) = best {
                return Some(candidate);
            }
        }
        None
    }
}

fn link_subtree(old: &Tree, new: &Tree, matching: &mut Matching, i: usize, j: usize) {
    let old_start = old.lo(i);
    let new_start = new.lo(j);
    for offset in 0..old.nodes[i].size {
        matching.link(old_start + offset, new_start + offset);
    }
}

pub(crate) struct Matching {
    pub(crate) old: Vec<Option<usize>>,
    pub(crate) new: Vec<Option<usize>>,
    owners: Option<(Vec<usize>, Vec<usize>)>,
}

impl Matching {
    pub(crate) fn new(old: usize, new: usize) -> Self {
        Self {
            old: vec![None; old],
            new: vec![None; new],
            owners: None,
        }
    }

    fn initialize_owners(&mut self, old: &Tree, new: &Tree) {
        fn owners<'a>(
            tree: &'a Tree,
            intern: &mut HashMap<(&'a str, &'a str), usize>,
        ) -> Vec<usize> {
            let mut owners = vec![0; tree.len()];
            for i in (0..tree.len()).rev() {
                owners[i] = if let Some(key) = tree.match_key(crate::NodeId(i)) {
                    let next = intern.len() + 1;
                    *intern.entry((&tree.nodes[i].kind, key)).or_insert(next)
                } else {
                    tree.nodes[i].parent.map_or(0, |parent| owners[parent.0])
                };
            }
            owners
        }
        if !old.has_match_keys() && !new.has_match_keys() {
            return;
        }
        // Hinted receiver scopes are closed matching boundaries, including the
        // declaration itself. Labels are deliberately absent: a method rename
        // within the same receiver must still match. Unhinted comparisons need
        // no owner arrays; hinted comparisons allocate only two linear arrays.
        let mut intern = HashMap::new();
        self.owners = Some((owners(old, &mut intern), owners(new, &mut intern)));
    }

    fn old_owner(&self, i: usize) -> usize {
        self.owners.as_ref().map_or(0, |(old, _)| old[i])
    }

    fn new_owner(&self, j: usize) -> usize {
        self.owners.as_ref().map_or(0, |(_, new)| new[j])
    }

    fn compatible(&self, i: usize, j: usize) -> bool {
        self.old_owner(i) == self.new_owner(j)
    }

    pub(crate) fn link(&mut self, i: usize, j: usize) {
        if self.old[i].is_none() && self.new[j].is_none() && self.compatible(i, j) {
            self.old[i] = Some(j);
            self.new[j] = Some(i);
        }
    }
}

pub(crate) fn top_down(old: &Tree, new: &Tree, matching: &mut Matching, min_height: usize) {
    matching.initialize_owners(old, new);
    let height = old.nodes[old.root().0]
        .height
        .max(new.nodes[new.root().0].height);
    let mut old_buckets = vec![Vec::new(); height + 1];
    let mut new_buckets = vec![Vec::new(); height + 1];
    old_buckets[old.nodes[old.root().0].height].push(old.root().0);
    new_buckets[new.nodes[new.root().0].height].push(new.root().0);
    let mut by_hash: HashMap<(u64, usize), HashBucket<'_>> = HashMap::new();

    for h in (1..=height).rev() {
        let a = std::mem::take(&mut old_buckets[h]);
        let b = std::mem::take(&mut new_buckets[h]);
        if !a.is_empty() && !b.is_empty() {
            by_hash.clear();
            for &j in &b {
                if matching.new[j].is_none() {
                    by_hash
                        .entry((new.nodes[j].content_hash, matching.new_owner(j)))
                        .or_default()
                        .candidates
                        .push(j);
                }
            }
            for &i in &a {
                if matching.old[i].is_some() {
                    continue;
                }
                let Some(bucket) =
                    by_hash.get_mut(&(old.nodes[i].content_hash, matching.old_owner(i)))
                else {
                    continue;
                };
                if h < min_height && bucket.candidates.len() > MAX_ALIGN {
                    continue;
                }
                if h >= min_height && bucket.candidates.len() > MAX_ALIGN {
                    if let Some(j) = bucket.aligned_candidate(old, new, matching, i) {
                        link_subtree(old, new, matching, i, j);
                        continue;
                    }
                }
                while bucket.first_unclaimed < bucket.candidates.len()
                    && matching.new[bucket.candidates[bucket.first_unclaimed]].is_some()
                {
                    bucket.first_unclaimed += 1;
                }
                let candidates = &bucket.candidates[bucket.first_unclaimed..];
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
                link_subtree(old, new, matching, i, j);
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
    type PathKey<'a> = (usize, &'a str, &'a str, Option<&'a str>);
    fn paths<'a>(tree: &'a Tree, intern: &mut HashMap<PathKey<'a>, usize>) -> Vec<usize> {
        let mut result = vec![0; tree.len()];
        for i in (0..tree.len()).rev() {
            let parent = tree.nodes[i].parent.map_or(0, |p| result[p.0]);
            result[i] =
                if let Some(label) = tree.nodes[i].label.as_deref().filter(|s| !s.is_empty()) {
                    let next_id = intern.len() + 1;
                    *intern
                        .entry((
                            parent,
                            &tree.nodes[i].kind,
                            label,
                            tree.match_key(crate::NodeId(i)),
                        ))
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

#[derive(Clone, Copy)]
struct DescendantMatches {
    count: usize,
    min_new: usize,
    max_new: usize,
}

impl Default for DescendantMatches {
    fn default() -> Self {
        Self {
            count: 0,
            min_new: usize::MAX,
            max_new: 0,
        }
    }
}

fn dice(count: usize, old_descendants: usize, new_descendants: usize) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    // Counts fit addressable memory; only relative scores need floating point.
    let score = 2.0 * count as f64 / (old_descendants + new_descendants) as f64;
    score
}

fn near_complete_parent(
    old: &Tree,
    new: &Tree,
    matching: &Matching,
    i: usize,
    descendants: DescendantMatches,
) -> Option<(usize, f64)> {
    let size = old.nodes[i].size;
    let count = descendants.count;
    if count == 0 || size - 1 - count > 1 {
        return None;
    }
    let last_child = matching.old[i - 1]?;
    let candidate = new.nodes[last_child].parent?.0;
    if matching.new[candidate].is_some()
        || old.nodes[i].kind != new.nodes[candidate].kind
        || !matching.compatible(i, candidate)
        || size != new.nodes[candidate].size
        || descendants.min_new < new.lo(candidate)
        || descendants.max_new >= candidate
    {
        return None;
    }
    let score = dice(count, size - 1, size - 1);
    // All mapped descendants lie inside this equal-sized target. At most one
    // target descendant is unmatched, hence at most one interior candidate can
    // precede the target in the four-candidate shortlist. Every ancestor has
    // the target's frontier count and is discovered after it. The target also
    // strictly beats every interior candidate (at most count-1 common nodes)
    // and every ancestor. Check the bounds in floating point too, preserving
    // the exhaustive tie rule even if very large counts round to equal scores.
    if score <= dice(count - 1, size - 1, count - 1) || score <= dice(count, size - 1, size) {
        return None;
    }
    Some((candidate, score))
}

pub(crate) fn bottom_up(old: &Tree, new: &Tree, matching: &mut Matching, ratio: f64) {
    let mut stamp = vec![usize::MAX; new.len()];
    let mut common = vec![0_usize; new.len()];
    let mut candidates = Vec::new();
    // Earlier descendants' mappings are final in ascending postorder. Aggregate
    // immediate children once to avoid rescanning deep, nearly matched chains.
    let mut summaries = vec![DescendantMatches::default(); old.len()];
    for i in 0..old.len() {
        let mut descendants = DescendantMatches::default();
        for child in &old.nodes[i].children {
            let child = summaries[child.0];
            descendants.count += child.count;
            descendants.min_new = descendants.min_new.min(child.min_new);
            descendants.max_new = descendants.max_new.max(child.max_new);
        }
        if matching.old[i].is_none() && descendants.count > 0 {
            let best = if let Some(best) = near_complete_parent(old, new, matching, i, descendants)
            {
                Some(best)
            } else {
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
                        if new.nodes[a.0].kind == old.nodes[i].kind && matching.compatible(i, a.0) {
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
                    let start = new.lo(candidate);
                    let count = (old.lo(i)..i)
                        .filter(|&d| matching.old[d].is_some_and(|j| j >= start && j < candidate))
                        .count();
                    let score = dice(count, old.nodes[i].size - 1, new.nodes[candidate].size - 1);
                    if score > best_dice {
                        best = Some(candidate);
                        best_dice = score;
                    }
                }
                best.map(|candidate| (candidate, best_dice))
            };
            if let Some((candidate, score)) = best {
                if (old.nodes[i].parent.is_none() && score > 0.0) || score >= ratio {
                    matching.link(i, candidate);
                }
            }
        }
        if let Some(j) = matching.old[i] {
            descendants.count += 1;
            descendants.min_new = descendants.min_new.min(j);
            descendants.max_new = descendants.max_new.max(j);
        }
        summaries[i] = descendants;
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
                if old.nodes[x].kind == new.nodes[y].kind && matching.compatible(x, y) {
                    matching.link(x, y);
                }
            }
            continue;
        }
        let width = new_leaves.len() + 1;
        let mut table = vec![0_usize; (old_leaves.len() + 1) * width];
        for x in (0..old_leaves.len()).rev() {
            for y in (0..new_leaves.len()).rev() {
                table[x * width + y] = if old.nodes[old_leaves[x]].kind
                    == new.nodes[new_leaves[y]].kind
                    && matching.compatible(old_leaves[x], new_leaves[y])
                {
                    table[(x + 1) * width + y + 1] + 1
                } else {
                    table[(x + 1) * width + y].max(table[x * width + y + 1])
                };
            }
        }
        let (mut x, mut y) = (0, 0);
        while x < old_leaves.len() && y < new_leaves.len() {
            if old.nodes[old_leaves[x]].kind == new.nodes[new_leaves[y]].kind
                && matching.compatible(old_leaves[x], new_leaves[y])
            {
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
                if matching.new[candidates[0]].is_none() && matching.compatible(i, candidates[0]) {
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
            if matching.new[j].is_some() || !matching.compatible(i, j) {
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
    use super::*;
    use crate::{NodeSpec, TreeBuilder};
    use std::sync::Arc;

    #[test]
    fn links_are_bijective_and_never_overwritten() {
        let mut matching = Matching::new(3, 3);
        matching.link(0, 0);
        matching.link(0, 1);
        matching.link(1, 0);
        assert_eq!(matching.old, [Some(0), None, None]);
        assert_eq!(matching.new, [Some(0), None, None]);
    }
    #[test]
    fn nearest_hinted_owner_includes_itself_and_overrides_its_ancestor() {
        let mut builder = TreeBuilder::new();
        let plain = builder.push(NodeSpec::new("token")).unwrap();
        let nested = builder.push(NodeSpec::new("token")).unwrap();
        let mut inner = NodeSpec::new("Method");
        inner.match_key = Some("inner".to_owned());
        inner.children.push(nested);
        let inner = builder.push(inner).unwrap();
        let mut outer = NodeSpec::new("Method");
        outer.match_key = Some("outer".to_owned());
        outer.children = vec![plain, inner];
        let outer = builder.push(outer).unwrap();
        let mut root = NodeSpec::new("file");
        root.children.push(outer);
        let root = builder.push(root).unwrap();
        let tree = builder.finish(root).unwrap();
        let mut matching = Matching::new(tree.len(), tree.len());
        matching.initialize_owners(&tree, &tree);
        assert!(matching.compatible(outer.0, plain.0));
        assert!(matching.compatible(inner.0, nested.0));
        assert!(!matching.compatible(outer.0, inner.0));
        assert!(!matching.compatible(root.0, plain.0));
        matching.link(plain.0, nested.0);
        assert_eq!(matching.old[plain.0], None);
        matching.link(nested.0, nested.0);
        assert_eq!(matching.old[nested.0], Some(nested.0));
    }

    fn reference_bottom_up(old: &Tree, new: &Tree, matching: &mut Matching, ratio: f64) {
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

    fn reference_top_down(old: &Tree, new: &Tree, matching: &mut Matching, min_height: usize) {
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

    fn repeated_parents(mut seed: u64, variant: bool) -> Arc<Tree> {
        let mut builder = TreeBuilder::new();
        let mut parents = Vec::new();
        for parent_index in 0..8 {
            let mut children = Vec::new();
            for _ in 0..60 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                if variant && seed % 11 == 0 {
                    continue;
                }
                let mut leaf = NodeSpec::new("token");
                // Equal legacy concatenations intentionally collide.
                let (label, value) = if seed % 5 == 0 {
                    ("ab", "c")
                } else {
                    ("a", "bc")
                };
                leaf.label = Some(label.to_owned());
                leaf.value = Some(value.to_owned());
                let child = builder.push(leaf).unwrap();
                let mut block = NodeSpec::new("block");
                block.children.push(child);
                children.push(builder.push(block).unwrap());
            }
            let mut marker = NodeSpec::new("marker");
            marker.value = Some(format!("{parent_index}-{variant}"));
            children.push(builder.push(marker).unwrap());
            let mut parent = NodeSpec::new(if parent_index % 3 == 0 {
                "other_parent"
            } else {
                "parent"
            });
            parent.children = children;
            parents.push(builder.push(parent).unwrap());
        }
        let mut root = NodeSpec::new("root");
        root.children = parents;
        let root = builder.push(root).unwrap();
        builder.finish(root).unwrap()
    }

    #[test]
    fn indexed_repeated_candidates_preserve_exhaustive_reference_ties_and_collision_checks() {
        for seed in 1..=12 {
            let old = repeated_parents(seed, false);
            let new = repeated_parents(seed * 17, true);
            for min_height in [1, 2, 3] {
                let mut expected = Matching::new(old.len(), new.len());
                reference_top_down(&old, &new, &mut expected, min_height);
                let mut actual = Matching::new(old.len(), new.len());
                top_down(&old, &new, &mut actual, min_height);
                assert_eq!(
                    actual.old, expected.old,
                    "seed {seed}, min_height {min_height}"
                );
                assert_eq!(
                    actual.new, expected.new,
                    "seed {seed}, min_height {min_height}"
                );
            }
        }
    }
    fn random_tree(seed: &mut u64, leaves: usize) -> Arc<Tree> {
        fn next(seed: &mut u64) -> u64 {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        }
        fn build(builder: &mut TreeBuilder, seed: &mut u64, leaves: usize) -> crate::NodeId {
            if leaves == 1 {
                let mut leaf = NodeSpec::new("token");
                leaf.value = Some((next(seed) % 7).to_string());
                return builder.push(leaf).unwrap();
            }
            let width = usize::try_from(next(seed) % 4 + 2).unwrap().min(leaves);
            let mut parent = NodeSpec::new(if next(seed) % 3 == 0 { "other" } else { "box" });
            for index in 0..width {
                let count = leaves / width + usize::from(index < leaves % width);
                parent.children.push(build(builder, seed, count));
            }
            builder.push(parent).unwrap()
        }
        let mut builder = TreeBuilder::new();
        let root = build(&mut builder, seed, leaves);
        builder.finish(root).unwrap()
    }

    fn assert_bottom_up_parity(old: &Tree, new: &Tree, pairs: &[(usize, usize)], ratio: f64) {
        let mut expected = Matching::new(old.len(), new.len());
        let mut actual = Matching::new(old.len(), new.len());
        for &(i, j) in pairs {
            expected.link(i, j);
            actual.link(i, j);
        }
        reference_bottom_up(old, new, &mut expected, ratio);
        bottom_up(old, new, &mut actual, ratio);
        assert_eq!(actual.old, expected.old, "ratio {ratio}, pairs {pairs:?}");
        assert_eq!(actual.new, expected.new, "ratio {ratio}, pairs {pairs:?}");
    }

    #[test]
    fn bottom_up_summary_preserves_exhaustive_reference_with_crossing_moves() {
        for seed in 1..=80 {
            let old = random_tree(&mut (seed * 17), 40);
            let new = random_tree(&mut (seed * 31), 40);
            // Real top-down matches include whole-subtree links and collisions.
            let mut initial = Matching::new(old.len(), new.len());
            top_down(&old, &new, &mut initial, 2);
            let pairs: Vec<_> = initial
                .old
                .iter()
                .enumerate()
                .filter_map(|(i, &j)| j.map(|j| (i, j)))
                .collect();
            for ratio in [0.0, 0.2, 0.5, 1.0, f64::NAN] {
                let dense: Vec<_> = (0..old.root().0)
                    .filter(|i| *i != usize::try_from(seed).unwrap() % old.root().0)
                    .map(|i| (i, i))
                    .collect();
                assert_bottom_up_parity(&old, &old, &dense, ratio);
                assert_bottom_up_parity(&old, &new, &pairs, ratio);
                // A bijection with cross-subtree and ancestor moves exercises
                // containment rejection independently of preceding heuristics.
                let pairs: Vec<_> = (0..old.len().min(new.len()))
                    .filter(|i| i % 3 != 0)
                    .map(|i| (i, (i + usize::try_from(seed).unwrap()) % new.len()))
                    .collect();
                assert_bottom_up_parity(&old, &new, &pairs, ratio);
            }
        }
    }

    #[test]
    fn anchored_chain_matches_exhaustive_reference_across_thresholds() {
        let mut builder = TreeBuilder::new();
        let anchor = builder.push(NodeSpec::new("token")).unwrap();
        let changed = builder.push(NodeSpec::new("token")).unwrap();
        let mut base = NodeSpec::new("box");
        base.children = vec![anchor, changed];
        let mut root = builder.push(base).unwrap();
        for _ in 0..120 {
            let mut parent = NodeSpec::new("box");
            parent.children.push(root);
            root = builder.push(parent).unwrap();
        }
        let tree = builder.finish(root).unwrap();
        for ratio in [0.0, 0.49, 0.5, 0.51, 1.0, f64::NAN] {
            // A changed leaf remains unmatched until leaf recovery; the parent
            // ratio threshold must still govern every link along the chain.
            assert_bottom_up_parity(&tree, &tree, &[(anchor.0, anchor.0)], ratio);
            assert_bottom_up_parity(
                &tree,
                &tree,
                &[(anchor.0, anchor.0), (root.0, root.0)],
                ratio,
            );
        }
    }

    #[test]
    fn nearly_complete_ancestors_match_reference_with_one_unmatched_interior_node() {
        let mut builder = TreeBuilder::new();
        let leaves: Vec<_> = (0..10)
            .map(|_| builder.push(NodeSpec::new("token")).unwrap())
            .collect();
        let mut inner = NodeSpec::new("box");
        inner.children = leaves;
        let inner = builder.push(inner).unwrap();
        let mut outer = NodeSpec::new("box");
        outer.children.push(inner);
        let outer = builder.push(outer).unwrap();
        let last = builder.push(NodeSpec::new("token")).unwrap();
        let mut root = NodeSpec::new("box");
        root.children = vec![outer, last];
        let root = builder.push(root).unwrap();
        let tree = builder.finish(root).unwrap();
        // The one unmatched interior container has ten frontier votes; the
        // target has only one, because the claimed outer container stops those
        // traversals. The target remains shortlisted and has a higher Dice.
        let pairs: Vec<_> = (0..root.0)
            .filter(|&i| i != inner.0)
            .map(|i| (i, i))
            .collect();
        for ratio in [0.0, 0.5, 0.99, 1.0, f64::NAN] {
            assert_bottom_up_parity(&tree, &tree, &pairs, ratio);
        }
        let mut matching = Matching::new(tree.len(), tree.len());
        for &(i, j) in &pairs {
            matching.link(i, j);
        }
        let descendants = DescendantMatches {
            count: 12,
            min_new: 0,
            max_new: last.0,
        };
        assert_eq!(
            near_complete_parent(&tree, &tree, &matching, root.0, descendants),
            Some((root.0, 12.0 / 13.0))
        );
        // Full mappings take the same shortcut with a perfect score.
        matching.link(inner.0, inner.0);
        assert_eq!(
            near_complete_parent(
                &tree,
                &tree,
                &matching,
                root.0,
                DescendantMatches {
                    count: 13,
                    ..descendants
                }
            ),
            Some((root.0, 1.0))
        );
    }
}
