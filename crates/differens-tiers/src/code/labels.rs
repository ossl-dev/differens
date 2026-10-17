use tree_sitter::Node;

fn text(node: Node<'_>, source: &str) -> String {
    source[node.byte_range()].to_owned()
}
fn child_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| child.kind() == kind)
}
fn descendant<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut pending = vec![node];
    while let Some(current) = pending.pop() {
        if current.kind() == kind {
            return Some(current);
        }
        let mut cursor = current.walk();
        let children: Vec<_> = current.named_children(&mut cursor).collect();
        pending.extend(children.into_iter().rev());
    }
    None
}
fn identifier(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| {
            matches!(
                child.kind(),
                "simple_identifier" | "type_identifier" | "identifier"
            )
        })
        .or_else(|| child_kind(node, "variable_declaration").and_then(identifier))
}

pub(super) fn extract(language: &str, node: Node<'_>, source: &str) -> Option<String> {
    if let Some(name) = node.child_by_field_name("name") {
        return Some(text(name, source));
    }
    let found =
        match (language, node.kind()) {
            ("typescript", "variable_declaration" | "lexical_declaration") => {
                child_kind(node, "variable_declarator")
                    .and_then(|child| child.child_by_field_name("name"))
            }
            ("python", "decorated_definition") => node
                .child_by_field_name("definition")
                .and_then(|definition| definition.child_by_field_name("name")),
            ("python", "assignment" | "augmented_assignment") => node.child_by_field_name("left"),
            ("rust", "type_item") => node.child_by_field_name("type"),
            ("c" | "cpp", "function_definition" | "declaration" | "field_declaration") => {
                let mut declarator = node.child_by_field_name("declarator");
                while let Some(inner) = declarator.and_then(|child| {
                    child.child_by_field_name("declarator").or_else(|| {
                        if child.kind() == "parenthesized_declarator" {
                            child.named_child(0)
                        } else {
                            None
                        }
                    })
                }) {
                    declarator = Some(inner);
                }
                declarator
            }
            ("java", "local_variable_declaration" | "field_declaration") => node
                .child_by_field_name("declarator")
                .and_then(|child| child.child_by_field_name("name")),
            ("ruby", "instance_variable") => Some(node),
            ("php", "property_declaration") => child_kind(node, "property_element")
                .and_then(|child| child.child_by_field_name("name")),
            (
                "kotlin",
                "class_declaration"
                | "function_declaration"
                | "property_declaration"
                | "variable_declaration"
                | "type_alias"
                | "parameter"
                | "class_parameter"
                | "enum_entry",
            ) => identifier(node),
            ("csharp", "variable_declaration" | "field_declaration") => {
                descendant(node, "variable_declarator")
                    .and_then(|child| child.child_by_field_name("name"))
            }
            ("scala", "val_definition" | "var_definition") => node
                .child_by_field_name("pattern")
                .or_else(|| child_kind(node, "identifier")),
            ("lua", "variable_declaration") => descendant(node, "variable_list")
                .and_then(|child| child.child_by_field_name("name")),
            _ => None,
        };
    found.map(|node| text(node, source))
}

// A Go method's receiver identifies its owning type independently of the local
// receiver variable, pointer form, or generic parameter names. This is matcher
// metadata only; public labels remain the original method name.
pub(super) fn match_key(language: &str, node: Node<'_>, source: &str) -> Option<String> {
    if language != "go" || node.kind() != "method_declaration" {
        return None;
    }
    let receiver = node.child_by_field_name("receiver")?;
    let declaration = child_kind(receiver, "parameter_declaration")?;
    let mut receiver_type = declaration.child_by_field_name("type")?;
    while receiver_type.kind() == "pointer_type" {
        receiver_type = receiver_type.named_child(0)?;
    }
    if receiver_type.kind() == "generic_type" {
        receiver_type = receiver_type.child_by_field_name("type")?;
    }
    Some(format!("go::{}", &source[receiver_type.byte_range()]))
}
