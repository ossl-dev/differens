/**
 * Rust language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  source_file: "file",
  function_item: "Function",
  function_signature_item: "Function",
  struct_item: "Struct",
  enum_item: "Enum",
  trait_item: "Trait",
  impl_item: "Impl",
  type_item: "TypeDef",
  const_item: "Constant",
  static_item: "Static",
  use_declaration: "Import",
  mod_item: "Module",
  macro_definition: "Macro",
  macro_invocation: "MacroCall",
  attribute_item: "Attribute",
  inner_attribute_item: "InnerAttribute",
  let_declaration: "Variable",
  if_expression: "IfBlock",
  else_clause: "ElseBlock",
  match_expression: "MatchBlock",
  match_arm: "MatchArm",
  for_expression: "ForLoop",
  while_expression: "WhileLoop",
  loop_expression: "Loop",
  closure_expression: "Closure",
  return_expression: "Return",
  break_expression: "Break",
  continue_expression: "Continue",
  block: "Block",
  call_expression: "CallExpression",
  method_call_expression: "MethodCall",
  field_expression: "FieldAccess",
  index_expression: "IndexAccess",
  assignment_expression: "Assignment",
  compound_assignment_expr: "AugmentedAssignment",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  range_expression: "Range",
  reference_expression: "Reference",
  dereference_expression: "Deref",
  try_expression: "TryBlock",
  unsafe_block: "UnsafeBlock",
  async_block: "AsyncBlock",
  await_expression: "Await",
  string_literal: "string_literal",
  raw_string_literal: "string_literal",
  integer_literal: "integer_literal",
  float_literal: "float_literal",
  boolean_literal: "boolean_literal",
  char_literal: "char_literal",
  unit_expression: "unit_literal",
  array_expression: "ArrayLiteral",
  tuple_expression: "TupleLiteral",
  struct_expression: "StructLiteral",
  identifier: "identifier",
  type_identifier: "TypeIdentifier",
  field_identifier: "FieldIdentifier",
  generic_type: "GenericType",
  reference_type: "ReferenceType",
  pointer_type: "PointerType",
  array_type: "ArrayType",
  tuple_type: "TupleType",
  function_type: "FunctionType",
  trait_bounds: "TraitBounds",
  where_clause: "WhereClause",
  type_parameters: "TypeParameters",
  lifetime: "Lifetime",
  parameters: "Parameters",
  arguments: "Arguments",
  self_parameter: "SelfParam",
  lifetime_annotation: "LifetimeAnnotation",
  token_tree: "TokenTree",
  comment: "Comment",
  line_comment: "Comment",
  block_comment: "Comment",
};

export class RustExtractor implements LanguageExtractor {
  readonly language = "rust";
  readonly extensions = ["rs"];

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // Type definitions have a "type" field
    if (node.type === "type_item") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) return source.slice(typeNode.startIndex, typeNode.endIndex);
    }

    return undefined;
  }

  isOrdered(nodeKind: string): boolean {
    if (nodeKind === "Import" || nodeKind === "Attribute") return false;
    return true;
  }
}
