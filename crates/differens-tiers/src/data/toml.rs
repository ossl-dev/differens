//! Read TOML's typed syntax tree directly. Datetimes stay scalar strings and
//! ordinary user tables cannot be mistaken for Serde's private datetime map.
use crate::ParseError;
use serde_json::{Map, Number, Value};
use toml_edit::{Item, Table};

pub(super) fn parse(source: &str) -> Result<Value, ParseError> {
    let document = source
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| ParseError::Syntax(error.to_string()))?;
    let mut visited = 0;
    table(document.as_table(), 0, &mut visited)
}
fn budget(depth: usize, visited: &mut usize, children: usize) -> Result<(), ParseError> {
    *visited = visited.saturating_add(1);
    if depth > 256 || visited.saturating_add(children) > 50_000 {
        return Err(ParseError::Budget);
    }
    Ok(())
}
fn table(table: &Table, depth: usize, visited: &mut usize) -> Result<Value, ParseError> {
    budget(depth, visited, table.len())?;
    let mut object = Map::with_capacity(table.len());
    for (key, item) in table {
        object.insert(key.to_owned(), node(item, depth + 1, visited)?);
    }
    Ok(Value::Object(object))
}
fn node(item: &Item, depth: usize, visited: &mut usize) -> Result<Value, ParseError> {
    match item {
        Item::Value(value) => scalar_or_collection(value, depth, visited),
        Item::Table(value) => table(value, depth, visited),
        Item::ArrayOfTables(array) => {
            budget(depth, visited, array.len())?;
            let mut values = Vec::with_capacity(array.len());
            for item in array {
                values.push(table(item, depth + 1, visited)?);
            }
            Ok(Value::Array(values))
        }
        Item::None => Err(ParseError::Syntax("empty TOML value".to_owned())),
    }
}
fn scalar_or_collection(
    value: &toml_edit::Value,
    depth: usize,
    visited: &mut usize,
) -> Result<Value, ParseError> {
    budget(depth, visited, 0)?;
    match value {
        toml_edit::Value::String(value) => Ok(Value::String(value.value().clone())),
        toml_edit::Value::Integer(value) => Ok(Value::from(*value.value())),
        toml_edit::Value::Float(value) => Number::from_f64(*value.value())
            .map(Value::Number)
            .ok_or_else(|| ParseError::Syntax("non-finite TOML number is unsupported".to_owned())),
        toml_edit::Value::Boolean(value) => Ok(Value::Bool(*value.value())),
        toml_edit::Value::Datetime(value) => Ok(Value::String(value.value().to_string())),
        toml_edit::Value::Array(array) => {
            if visited.saturating_add(array.len()) > 50_000 {
                return Err(ParseError::Budget);
            }
            let mut values = Vec::with_capacity(array.len());
            for value in array {
                values.push(scalar_or_collection(value, depth + 1, visited)?);
            }
            Ok(Value::Array(values))
        }
        toml_edit::Value::InlineTable(object) => {
            if visited.saturating_add(object.len()) > 50_000 {
                return Err(ParseError::Budget);
            }
            let mut values = Map::with_capacity(object.len());
            for (key, value) in object {
                values.insert(
                    key.to_owned(),
                    scalar_or_collection(value, depth + 1, visited)?,
                );
            }
            Ok(Value::Object(values))
        }
    }
}
