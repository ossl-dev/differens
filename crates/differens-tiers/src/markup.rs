//! Lenient HTML/XML tokenizer retaining every attribute and text run.
use crate::ParseError;
use differens_core::{NodeSpec, Tree, TreeBuilder};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, Default)]
struct Element {
    tag: String,
    attrs: BTreeMap<String, String>,
    text: String,
    text_runs: Vec<([usize; 2], String)>,
    children: Vec<usize>,
    range: [usize; 2],
}

/// Parse lenient HTML/XML while retaining attribute identity.
///
/// # Errors
/// Rejects input exceeding the node/depth budget or an invalid generated topology.
pub fn parse_markup(source: &str) -> Result<Arc<Tree>, ParseError> {
    let mut elements = vec![Element {
        tag: "document".to_owned(),
        range: [0, source.len()],
        ..Element::default()
    }];
    let mut stack = vec![0];
    let mut pos = 0;
    let mut node_count = 1;
    while pos < source.len() {
        let rest = &source[pos..];
        if rest.starts_with("<!--") {
            if let Some(end) = rest.find("-->") {
                pos += end + 3;
                continue;
            }
            break;
        }
        let parent = *stack.last().ok_or(ParseError::Cancelled)?;
        if rest.starts_with('<') {
            if let Some(end) = tag_end(rest) {
                let body = &rest[1..end];
                if body.starts_with('/') {
                    if stack.len() > 1 {
                        let id = stack.pop().ok_or(ParseError::Cancelled)?;
                        elements[id].range[1] = pos + end + 1;
                    }
                    pos += end + 1;
                    continue;
                }
                let name_end = body
                    .find(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.')))
                    .unwrap_or(body.len());
                let tag = &body[..name_end];
                if tag.starts_with(|ch: char| ch.is_alphabetic()) {
                    let attrs = attributes(&body[name_end..], &mut node_count)?;
                    let id = elements.len();
                    node_count += 1;
                    if node_count > 50_000 || stack.len() > 256 {
                        return Err(ParseError::Budget);
                    }
                    elements.push(Element {
                        tag: tag.to_owned(),
                        attrs,
                        range: [pos, pos + end + 1],
                        ..Element::default()
                    });
                    elements[parent].children.push(id);
                    if !body.trim_end().ends_with('/')
                        && !matches!(
                            tag.to_ascii_lowercase().as_str(),
                            "area"
                                | "base"
                                | "br"
                                | "col"
                                | "embed"
                                | "hr"
                                | "img"
                                | "input"
                                | "link"
                                | "meta"
                                | "param"
                                | "source"
                                | "track"
                                | "wbr"
                        )
                    {
                        stack.push(id);
                    }
                    pos += end + 1;
                    continue;
                }
            }
        }
        let step = rest.chars().next().map_or(0, char::len_utf8);
        let end = rest[step..]
            .find('<')
            .map_or(source.len(), |offset| pos + offset + step);
        let last_child_start = elements[parent]
            .children
            .last()
            .map(|id| elements[*id].range[0]);
        let parent_element = &mut elements[parent];
        let fragment = &source[pos..end];
        if let Some((range, text)) = parent_element
            .text_runs
            .last_mut()
            .filter(|(range, _)| last_child_start.is_none_or(|child_start| range[0] > child_start))
        {
            range[1] = end;
            text.push_str(fragment);
        } else {
            parent_element
                .text_runs
                .push(([pos, end], fragment.to_owned()));
        }
        pos = end;
    }
    retain_text_order(&mut elements, &mut node_count)?;
    build_tree(&elements, source)
}

// Keep text-only elements compact and compatible. Mixed content needs ordered
// text children: aggregating it on the parent loses moves across inline tags.
fn retain_text_order(
    elements: &mut Vec<Element>,
    node_count: &mut usize,
) -> Result<(), ParseError> {
    for id in 0..elements.len() {
        if elements[id].children.is_empty() || elements[id].text_runs.is_empty() {
            continue;
        }
        let mut children = std::mem::take(&mut elements[id].children);
        for (range, text) in std::mem::take(&mut elements[id].text_runs) {
            *node_count += 1;
            if *node_count > 50_000 {
                return Err(ParseError::Budget);
            }
            children.push(elements.len());
            elements.push(Element {
                tag: "text_content".to_owned(),
                text,
                range,
                ..Element::default()
            });
        }
        children.sort_unstable_by_key(|child| elements[*child].range[0]);
        elements[id].children = children;
        elements[id].text = String::new();
    }
    Ok(())
}

fn build_tree(elements: &[Element], source: &str) -> Result<Arc<Tree>, ParseError> {
    let mut builder = TreeBuilder::new();
    builder.set_legacy_source(source);
    let mut built = vec![None; elements.len()];
    let mut visits = vec![(0, false)];
    while let Some((id, leave)) = visits.pop() {
        if !leave {
            visits.push((id, true));
            visits.extend(
                elements[id]
                    .children
                    .iter()
                    .rev()
                    .map(|child| (*child, false)),
            );
            continue;
        }
        let element = &elements[id];
        let mut children = Vec::new();
        // Child subtrees have already been built contiguously. Attributes follow
        // elements, sorted by name so spelling order never invents a move.
        for child in &element.children {
            children.push(built[*child].ok_or(ParseError::Cancelled)?);
        }
        for (name, value) in &element.attrs {
            let mut attr = NodeSpec::new("attribute");
            attr.label = Some(name.clone());
            attr.value = Some(value.clone());
            children.push(builder.push(attr)?);
        }
        let mut spec = NodeSpec::new(&element.tag);
        spec.label = element
            .attrs
            .get("id")
            .or_else(|| element.attrs.get("class"))
            .cloned();
        spec.value = if !element.text.is_empty() {
            Some(element.text.clone())
        } else if element.children.is_empty() {
            element.text_runs.first().map(|(_, text)| text.clone())
        } else {
            None
        };
        spec.children = children;
        spec.byte_range = element.range;
        built[id] = Some(builder.push(spec)?);
    }
    Ok(builder.finish(built[0].ok_or(ParseError::Cancelled)?)?)
}
fn tag_end(source: &str) -> Option<usize> {
    let mut quote = None;
    for (i, ch) in source.char_indices().skip(1) {
        if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() {
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
            } else if ch == '>' {
                return Some(i);
            }
        }
    }
    None
}
fn attributes(
    mut source: &str,
    node_count: &mut usize,
) -> Result<BTreeMap<String, String>, ParseError> {
    let mut attrs = BTreeMap::new();
    while !source.is_empty() {
        source = source.trim_start();
        if source.is_empty() || source == "/" {
            break;
        }
        let end = source
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '=' | '/' | '>'))
            .unwrap_or(source.len());
        if end == 0 {
            source = &source[source.chars().next().map_or(1, char::len_utf8)..];
            continue;
        }
        let name = source[..end].to_owned();
        source = source[end..].trim_start();
        let mut value = String::new();
        if let Some(rest) = source.strip_prefix('=') {
            source = rest.trim_start();
            if let Some(quote) = source.chars().next().filter(|ch| matches!(ch, '\'' | '"')) {
                source = &source[1..];
                let end = source.find(quote).unwrap_or(source.len());
                source[..end].clone_into(&mut value);
                source = source.get(end + 1..).unwrap_or("");
            } else {
                let end = source.find(char::is_whitespace).unwrap_or(source.len());
                source[..end].clone_into(&mut value);
                source = &source[end..];
            }
        }
        if attrs.insert(name, value).is_none() {
            *node_count += 1;
            if *node_count > 50_000 {
                return Err(ParseError::Budget);
            }
        }
    }
    Ok(attrs)
}
