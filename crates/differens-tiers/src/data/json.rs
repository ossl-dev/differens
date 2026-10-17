//! Bound JSON-family parser work and reject non-finite values instead of
//! allowing `serde_json::Value`'s float visitor to silently turn them into null.
use crate::ParseError;
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use std::fmt;

pub(super) fn check_budget(source: &str) -> Result<(), ParseError> {
    let bytes = source.as_bytes();
    let mut position = 0;
    let mut depth = 0_usize;
    let mut nodes = 0;
    while position < bytes.len() {
        let byte = bytes[position];
        if byte.is_ascii_whitespace() || matches!(byte, b',' | b':') {
            position += 1;
            continue;
        }
        if bytes[position..].starts_with(b"//") {
            position += 2;
            while position < bytes.len() && !matches!(bytes[position], b'\n' | b'\r') {
                position += 1;
            }
            continue;
        }
        if bytes[position..].starts_with(b"/*") {
            position += 2;
            while position < bytes.len() && !bytes[position..].starts_with(b"*/") {
                position += 1;
            }
            position = (position + 2).min(bytes.len());
            continue;
        }
        if matches!(byte, b']' | b'}') {
            depth = depth.saturating_sub(1);
            position += 1;
            continue;
        }
        nodes += 1;
        // Object keys count as nodes here. The temporary representation stays
        // within twice the 50k semantic-node budget even before deserialization.
        if nodes > 100_000 {
            return Err(ParseError::Budget);
        }
        if matches!(byte, b'[' | b'{') {
            depth += 1;
            if depth > 256 {
                return Err(ParseError::Budget);
            }
            position += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            position += 1;
            while position < bytes.len() {
                let current = bytes[position];
                position += 1;
                if current == b'\\' {
                    position = (position + 1).min(bytes.len());
                } else if current == byte {
                    break;
                }
            }
        } else {
            position += 1;
            while position < bytes.len()
                && !bytes[position].is_ascii_whitespace()
                && !matches!(
                    bytes[position],
                    b',' | b':' | b'[' | b']' | b'{' | b'}' | b'\'' | b'"' | b'/'
                )
            {
                position += 1;
            }
        }
    }
    Ok(())
}

pub(super) fn parse_json5(source: &str) -> Result<Value, ParseError> {
    check_budget(source)?;
    json5::from_str::<FiniteValue>(source)
        .map(|value| value.0)
        .map_err(|error| ParseError::Syntax(error.to_string()))
}

struct FiniteValue(Value);
impl<'de> Deserialize<'de> for FiniteValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(FiniteVisitor).map(Self)
    }
}
struct FiniteVisitor;
impl<'de> Visitor<'de> for FiniteVisitor {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a finite JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON5 number is unsupported"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<FiniteValue>()? {
            values.push(value.0);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some((key, value)) = map.next_entry::<String, FiniteValue>()? {
            values.insert(key, value.0);
        }
        Ok(Value::Object(values))
    }
}
