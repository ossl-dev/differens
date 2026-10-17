//! Format-directed structured data with typed scalar identity.
//! Scalar ranges are local synthetic UTF-16 widths for the legacy wire format,
//! rather than locations in the original document.
//! JSON5 requires Pest >=2.9.4 for native stack guards; TOML retains its default
//! recursion limit, and YAML is checked before recursive tree construction.
use crate::ParseError;
use differens_core::{NodeId, NodeSpec, Tree, TreeBuilder};
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Arc};
use yaml_rust2::{
    Yaml, YamlLoader,
    parser::{Event, Parser},
};

/// Infer a structured format and parse its typed values.
///
/// # Errors
/// Rejects invalid syntax, unsupported values, and trees exceeding the node/depth budget.
pub fn parse_data(source: &str) -> Result<Arc<Tree>, ParseError> {
    let trimmed = source.trim();
    let extension =
        if trimmed.starts_with('{') || trimmed.starts_with('[') && !trimmed.contains('=') {
            "json5"
        } else if trimmed.contains(':') {
            "yaml"
        } else if trimmed.contains('=') || trimmed.starts_with('[') {
            "ini"
        } else {
            "scalar"
        };
    parse_data_as(source, extension)
}
/// Parse the specified file format into a typed semantic tree.
///
/// # Errors
/// Rejects invalid syntax, unsupported values, and trees exceeding the node/depth budget.
pub fn parse_data_as(source: &str, extension: &str) -> Result<Arc<Tree>, ParseError> {
    let value = match extension {
        "json" => {
            serde_json::from_str(source).map_err(|error| ParseError::Syntax(error.to_string()))?
        }
        "jsonc" | "json5" => {
            json5::from_str(source).map_err(|error| ParseError::Syntax(error.to_string()))?
        }
        "yaml" | "yml" => {
            check_yaml_budget(source)?;
            let documents = YamlLoader::load_from_str(source)
                .map_err(|error| ParseError::Syntax(error.to_string()))?;
            if documents.len() > 1 {
                Value::Array(
                    documents
                        .iter()
                        .map(|value| yaml_value(value, 0))
                        .collect::<Result<_, _>>()?,
                )
            } else {
                documents
                    .first()
                    .map(|value| yaml_value(value, 0))
                    .transpose()?
                    .unwrap_or(Value::Null)
            }
        }
        "toml" => {
            let value: toml::Value =
                toml::from_str(source).map_err(|error| ParseError::Syntax(error.to_string()))?;
            serde_json::to_value(value).map_err(|error| ParseError::Syntax(error.to_string()))?
        }
        "env" | "local" | "ini" | "cfg" => parse_assignments(source)?,
        _ => Value::String(source.trim().to_owned()),
    };
    tree_from_value(&value)
}
// YamlLoader's tree construction recursively dispatches nested events and
// clones anchored subtrees. Preflight the iterative event API so depth and
// alias expansion are bounded before those recursive owners exist.
#[derive(Clone, Copy, Default)]
struct YamlSize {
    nodes: usize,
    height: usize,
}
struct YamlFrame {
    anchor: usize,
    size: YamlSize,
}
fn check_yaml_budget(source: &str) -> Result<(), ParseError> {
    let mut parser = Parser::new_from_str(source);
    let mut frames: Vec<YamlFrame> = Vec::new();
    let mut anchors: HashMap<usize, YamlSize> = HashMap::new();
    let mut expanded_nodes = 0_usize;
    loop {
        let (event, _) = parser
            .next_token()
            .map_err(|error| ParseError::Syntax(error.to_string()))?;
        let (size, anchor) = match event {
            Event::StreamEnd => return Ok(()),
            Event::DocumentStart => {
                anchors.clear();
                continue;
            }
            Event::SequenceStart(anchor, _) | Event::MappingStart(anchor, _) => {
                if frames.len() > 256 {
                    return Err(ParseError::Budget);
                }
                expanded_nodes = expanded_nodes.saturating_add(1);
                if expanded_nodes > 100_000 {
                    return Err(ParseError::Budget);
                }
                frames.push(YamlFrame {
                    anchor,
                    size: YamlSize {
                        nodes: 1,
                        height: 0,
                    },
                });
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let Some(frame) = frames.pop() else {
                    return Err(ParseError::Syntax("unbalanced YAML collection".to_owned()));
                };
                (frame.size, frame.anchor)
            }
            Event::Scalar(_, _, anchor, _) => {
                expanded_nodes = expanded_nodes.saturating_add(1);
                (
                    YamlSize {
                        nodes: 1,
                        height: 0,
                    },
                    anchor,
                )
            }
            Event::Alias(anchor) => {
                let size = anchors.get(&anchor).copied().unwrap_or(YamlSize {
                    nodes: 1,
                    height: 0,
                });
                expanded_nodes = expanded_nodes.saturating_add(size.nodes);
                (size, 0)
            }
            _ => continue,
        };
        // Mapping keys are included here: the temporary YAML representation
        // contains at most two nodes per eventual semantic tree node.
        if expanded_nodes > 100_000 || frames.len() + size.height > 256 {
            return Err(ParseError::Budget);
        }
        if anchor != 0 {
            anchors.insert(anchor, size);
        }
        if let Some(parent) = frames.last_mut() {
            parent.size.nodes = parent.size.nodes.saturating_add(size.nodes);
            parent.size.height = parent.size.height.max(size.height + 1);
        }
    }
}
fn yaml_value(value: &Yaml, depth: usize) -> Result<Value, ParseError> {
    if depth > 256 {
        return Err(ParseError::Budget);
    }
    Ok(match value {
        Yaml::Real(value) => {
            serde_json::from_str(value).map_err(|error| ParseError::Syntax(error.to_string()))?
        }
        Yaml::Integer(value) => Value::from(*value),
        Yaml::String(value) => Value::String(value.clone()),
        Yaml::Boolean(value) => Value::Bool(*value),
        Yaml::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| yaml_value(value, depth + 1))
                .collect::<Result<_, _>>()?,
        ),
        Yaml::Hash(values) => {
            let mut object = Map::new();
            for (key, value) in values {
                let key = match key {
                    Yaml::String(key) => key.clone(),
                    _ => return Err(ParseError::Syntax("non-string YAML mapping key".to_owned())),
                };
                object.insert(key, yaml_value(value, depth + 1)?);
            }
            Value::Object(object)
        }
        Yaml::Null => Value::Null,
        Yaml::Alias(_) | Yaml::BadValue => {
            return Err(ParseError::Syntax(
                "unsupported YAML alias or value".to_owned(),
            ));
        }
    })
}
fn parse_assignments(source: &str) -> Result<Value, ParseError> {
    let mut root = Map::new();
    let mut section: Vec<&str> = Vec::new();
    for line in source.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].split('.').collect();
            continue;
        }
        let Some((key, value)) = line.strip_prefix("export ").unwrap_or(line).split_once('=')
        else {
            return Err(ParseError::Syntax(
                "expected KEY=VALUE assignment".to_owned(),
            ));
        };
        let mut object = &mut root;
        for part in &section {
            let entry = object
                .entry((*part).to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            object = entry
                .as_object_mut()
                .ok_or_else(|| ParseError::Syntax("section overlaps scalar".to_owned()))?;
        }
        let value = value.trim();
        let scalar = json5::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()));
        object.insert(key.trim().to_owned(), scalar);
    }
    Ok(Value::Object(root))
}
/// Build a semantic tree, preserving scalar types and insertion order.
///
/// # Errors
/// Rejects invalid syntax, unsupported values, and trees exceeding the node/depth budget.
pub fn tree_from_value(value: &Value) -> Result<Arc<Tree>, ParseError> {
    enum Job<'a> {
        Enter(&'a Value, String, usize),
        Leave(NodeSpec, usize),
    }
    let mut builder = TreeBuilder::new();
    let mut built: Vec<NodeId> = Vec::new();
    let mut jobs = vec![Job::Enter(value, "root".to_owned(), 0)];
    let mut count = 0;
    while let Some(job) = jobs.pop() {
        match job {
            Job::Enter(value, label, depth) => {
                count += 1;
                if count > 50_000 || depth > 256 {
                    return Err(ParseError::Budget);
                }
                let mut spec = NodeSpec::new(match value {
                    Value::Object(_) => "object",
                    Value::Array(_) => "array",
                    _ => "leaf",
                });
                spec.label = Some(label.clone());
                match value {
                    Value::Object(object) => {
                        jobs.push(Job::Leave(spec, object.len()));
                        for (key, value) in object.iter().rev() {
                            jobs.push(Job::Enter(value, key.clone(), depth + 1));
                        }
                    }
                    Value::Array(array) => {
                        jobs.push(Job::Leave(spec, array.len()));
                        for (i, value) in array.iter().enumerate().rev() {
                            jobs.push(Job::Enter(value, format!("{label}[{i}]"), depth + 1));
                        }
                    }
                    scalar => {
                        let (kind, text) = match scalar {
                            Value::Null => ("null", "null".to_owned()),
                            Value::Bool(value) => ("boolean", value.to_string()),
                            Value::Number(value) => ("number", value.to_string()),
                            Value::String(value) => ("string", value.clone()),
                            _ => unreachable!(),
                        };
                        spec.scalar_type = Some(kind.to_owned());
                        // Scalar ranges are local synthetic extents in the legacy UTF-16 coordinate system.
                        spec.byte_range = [0, text.encode_utf16().count()];
                        spec.value = Some(text);
                        built.push(builder.push(spec)?);
                    }
                }
            }
            Job::Leave(mut spec, children) => {
                spec.children = built.split_off(built.len() - children);
                built.push(builder.push(spec)?);
            }
        }
    }
    Ok(builder.finish(built.pop().ok_or(ParseError::Cancelled)?)?)
}
