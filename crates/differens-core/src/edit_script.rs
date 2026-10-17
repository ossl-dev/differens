use std::{collections::HashMap, sync::Arc};

use crate::{EditAction, NodeContext, NodeId, NodeRef, Tree, UpdateDetail, matching::Matching};

fn reference(tree: &Arc<Tree>, id: usize) -> NodeRef {
    NodeRef::new(Arc::clone(tree), NodeId(id))
}

fn ancestry(tree: &Tree, id: usize) -> Vec<NodeContext> {
    let mut context = Vec::new();
    let mut parent = tree.nodes[id].parent;
    while let Some(id) = parent {
        let node = &tree.nodes[id.0];
        context.push(NodeContext {
            kind: node.kind.clone(),
            label: node.label.clone(),
        });
        parent = node.parent;
    }
    context
}

pub(crate) fn generate(old: &Arc<Tree>, new: &Arc<Tree>, matching: &Matching) -> Vec<EditAction> {
    let mut updates = Vec::new();
    let mut moves = Vec::new();
    // Keep insertion order; randomized map iteration must never reorder actions.
    let mut reorder = Vec::<(usize, Vec<(usize, usize)>)>::new();
    let mut reorder_indices = HashMap::new();

    for (i, old_node) in old.nodes.iter().enumerate() {
        let Some(j) = matching.old[i] else {
            continue;
        };
        let new_node = &new.nodes[j];
        if old_node.label != new_node.label {
            updates.push(EditAction::Update {
                node: reference(new, j),
                context: ancestry(new, j),
                detail: UpdateDetail::Renamed {
                    from: old_node
                        .label
                        .clone()
                        .unwrap_or_else(|| "unnamed".to_owned()),
                    to: new_node
                        .label
                        .clone()
                        .unwrap_or_else(|| "unnamed".to_owned()),
                },
            });
        }
        if old_node.value != new_node.value || old_node.scalar_type != new_node.scalar_type {
            updates.push(EditAction::Update {
                node: reference(new, j),
                context: ancestry(new, j),
                detail: UpdateDetail::ValueChanged {
                    from: update_value(old_node, new_node),
                    to: update_value(new_node, old_node),
                },
            });
        }
        let (Some(pi), Some(pj)) = (old_node.parent, new_node.parent) else {
            continue;
        };
        if matching.old[pi.0] == Some(pj.0) {
            let next = reorder.len();
            let group = *reorder_indices.entry(pi.0).or_insert_with(|| {
                reorder.push((pi.0, Vec::new()));
                next
            });
            reorder[group].1.push((i, j));
        } else {
            if matching.old[pi.0].is_none() || matching.new[pj.0].is_none() {
                continue;
            }
            moves.push(move_action(old, new, i, j, pi.0, pj.0));
        }
    }
    for (parent, mut group) in reorder {
        if group.len() < 2 {
            continue;
        }
        group.sort_by_key(|&(i, _)| old.nodes[i].position);
        let keep = sibling_alignment(old, new, &group);
        for (k, (i, j)) in group.into_iter().enumerate() {
            if !keep[k] {
                moves.push(move_action(
                    old,
                    new,
                    i,
                    j,
                    parent,
                    new.nodes[j].parent.expect("reordered nodes have parents").0,
                ));
            }
        }
    }

    updates.extend(moves);
    updates.extend(unmatched_actions(old, new, matching));
    updates
}

fn sibling_alignment(old: &Tree, new: &Tree, group: &[(usize, usize)]) -> Vec<bool> {
    let sequence: Vec<_> = group.iter().map(|&(_, j)| new.nodes[j].position).collect();
    let mut keep = longest_increasing_subsequence(&sequence);
    let anchors: Vec<_> = group
        .iter()
        .enumerate()
        .filter_map(|(index, &(i, j))| {
            let old = &old.nodes[i];
            let new = &new.nodes[j];
            (!old.children.is_empty()
                && !new.children.is_empty()
                && old.label.as_deref().is_some_and(|label| !label.is_empty())
                && new.label.as_deref().is_some_and(|label| !label.is_empty()))
            .then_some(index)
        })
        .collect();
    if anchors.len() < 2
        || anchors.iter().all(|&index| keep[index])
        || anchors
            .windows(2)
            .any(|pair| sequence[pair[0]] >= sequence[pair[1]])
    {
        return keep;
    }
    // Duplicate anonymous siblings can claim the longest subsequence while
    // stable declarations are reported as moved. When every named container
    // retains its relative order, anchor those declarations and align only
    // siblings that stay within corresponding intervals. Cross-interval trivia
    // remains a move. Actual declaration reorders keep the legacy LIS and ties.
    keep.fill(false);
    let mut start = 0;
    let mut lower = None;
    let mut interval_indices = Vec::new();
    let mut interval_positions = Vec::new();
    for end in anchors.into_iter().chain(std::iter::once(group.len())) {
        let upper = sequence.get(end).copied().unwrap_or(usize::MAX);
        interval_indices.clear();
        interval_positions.clear();
        for (offset, &position) in sequence[start..end].iter().enumerate() {
            if lower.is_none_or(|lower| position > lower) && position < upper {
                interval_indices.push(start + offset);
                interval_positions.push(position);
            }
        }
        for (index, retained) in interval_indices
            .iter()
            .zip(longest_increasing_subsequence(&interval_positions))
        {
            keep[*index] = retained;
        }
        if end < group.len() {
            keep[end] = true;
            lower = Some(sequence[end]);
            start = end + 1;
        }
    }
    keep
}

fn update_value(node: &crate::Node, other: &crate::Node) -> Option<String> {
    if node.scalar_type == other.scalar_type {
        node.value.clone()
    } else {
        node.value.as_ref().map(|value| {
            format!(
                "{value} ({})",
                node.scalar_type.as_deref().unwrap_or("untyped")
            )
        })
    }
}

fn unmatched_actions(old: &Arc<Tree>, new: &Arc<Tree>, matching: &Matching) -> Vec<EditAction> {
    let mut actions = Vec::new();
    let mut removed = vec![false; old.len()];
    for i in (0..old.len()).rev() {
        if old.nodes[i].parent.is_some_and(|parent| removed[parent.0]) {
            removed[i] = true;
            continue;
        }
        if matching.old[i].is_some() {
            continue;
        }
        removed[i] = true;
        actions.push(EditAction::Delete {
            node: reference(old, i),
            context: ancestry(old, i),
        });
    }
    let mut covered = vec![false; new.len()];
    for j in (0..new.len()).rev() {
        let Some(parent) = new.nodes[j].parent else {
            continue;
        };
        if covered[parent.0] {
            covered[j] = true;
            continue;
        }
        if matching.new[j].is_some() {
            continue;
        }
        covered[j] = true;
        actions.push(EditAction::Insert {
            node: reference(new, j),
            parent: reference(new, parent.0),
            position: new.nodes[j].position,
            context: ancestry(new, j),
        });
    }
    actions
}

fn move_action(
    old: &Arc<Tree>,
    new: &Arc<Tree>,
    i: usize,
    j: usize,
    pi: usize,
    pj: usize,
) -> EditAction {
    EditAction::Move {
        node: reference(new, j),
        from_parent: reference(old, pi),
        to_parent: reference(new, pj),
        from_position: old.nodes[i].position,
        to_position: new.nodes[j].position,
        context: ancestry(new, j),
    }
}

/// Position flags of one longest strictly increasing subsequence, O(n log n).
fn longest_increasing_subsequence(sequence: &[usize]) -> Vec<bool> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![None; sequence.len()];
    for (i, &value) in sequence.iter().enumerate() {
        let position = tails.partition_point(|&tail| sequence[tail] < value);
        previous[i] = position.checked_sub(1).map(|p| tails[p]);
        if position == tails.len() {
            tails.push(i);
        } else {
            tails[position] = i;
        }
    }
    let mut keep = vec![false; sequence.len()];
    let mut current = tails.last().copied();
    while let Some(i) = current {
        keep[i] = true;
        current = previous[i];
    }
    keep
}

#[cfg(test)]
mod tests {
    use super::longest_increasing_subsequence;

    #[test]
    fn lis_retains_strict_order_and_legacy_ties() {
        assert_eq!(
            longest_increasing_subsequence(&[2, 0, 1]),
            [false, true, true]
        );
        assert_eq!(
            longest_increasing_subsequence(&[0, 2, 1]),
            [true, false, true]
        );
        assert_eq!(longest_increasing_subsequence(&[1, 1]), [false, true]);
        assert_eq!(longest_increasing_subsequence(&[]), [false; 0]);
    }
}
