/**
 * Go language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  source_file: "file",
  function_declaration: "Function",
  method_declaration: "Method",
  type_declaration: "TypeDecl",
  struct_type: "Struct",
  interface_type: "Interface",
  import_declaration: "Import",
  import_spec: "ImportSpec",
  const_declaration: "Constant",
  var_declaration: "Variable",
  short_var_declaration: "Variable",
  if_statement: "IfBlock",
  else_clause: "ElseBlock",
  for_statement: "ForLoop",
  switch_statement: "SwitchBlock",
  case_statement: "CaseClause",
  default_case: "DefaultCase",
  select_statement: "SelectBlock",
  go_statement: "Goroutine",
  defer_statement: "Defer",
  return_statement: "Return",
  break_statement: "Break",
  continue_statement: "Continue",
  block: "Block",
  call_expression: "CallExpression",
  selector_expression: "SelectorAccess",
  index_expression: "IndexAccess",
  slice_expression: "Slice",
  type_assertion_expression: "TypeAssertion",
  type_conversion_expression: "TypeConversion",
  assignment_statement: "Assignment",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  func_literal: "FunctionLiteral",
  composite_literal: "CompositeLiteral",
  literal_value: "LiteralValue",
  keyed_element: "KeyedElement",
  parameter_list: "Parameters",
  argument_list: "Arguments",
  type_parameter_list: "TypeParameters",
  interpreted_string_literal: "string_literal",
  raw_string_literal: "string_literal",
  int_literal: "integer_literal",
  float_literal: "float_literal",
  true: "boolean_literal",
  false: "boolean_literal",
  nil: "null_literal",
  iota: "iota",
  identifier: "identifier",
  type_identifier: "TypeIdentifier",
  field_identifier: "FieldIdentifier",
  package_identifier: "PackageIdentifier",
  label_name: "Label",
  field_declaration: "FieldDecl",
  method_spec: "MethodSpec",
  generic_type: "GenericType",
  pointer_type: "PointerType",
  array_type: "ArrayType",
  slice_type: "SliceType",
  map_type: "MapType",
  channel_type: "ChannelType",
  function_type: "FunctionType",
  qualified_type: "QualifiedType",
  comment: "Comment",
};

export class GoExtractor implements LanguageExtractor {
  readonly language = "go";
  readonly extensions = ["go"];

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    return undefined;
  }

}
