/**
 * Swift language extractor.
 *
 * Maps tree-sitter-swift node types to canonical concepts.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  source_file: "file",
  class_declaration: "Class",
  protocol_declaration: "Interface",
  function_declaration: "Function",
  property_declaration: "Variable",
  import_declaration: "Import",
  typealias_declaration: "TypeDef",
  enum_entry: "Enum",
  parameter: "Parameter",
  lambda_parameter: "Parameter",
  function_body: "Block",
  class_body: "Block",
  enum_class_body: "Block",
  protocol_body: "Block",
  statements: "Block",
  call_expression: "CallExpression",
  constructor_expression: "NewExpression",
  assignment: "Assignment",
  bang: "UnaryOp",
  prefix_expression: "UnaryOp",
  postfix_expression: "UnaryOp",
  comparison_expression: "BinaryOp",
  equality_expression: "BinaryOp",
  additive_expression: "BinaryOp",
  multiplicative_expression: "BinaryOp",
  infix_expression: "BinaryOp",
  nil_coalescing_expression: "BinaryOp",
  range_expression: "Range",
  ternary_expression: "TernaryOp",
  if_statement: "IfBlock",
  for_statement: "ForLoop",
  while_statement: "WhileLoop",
  repeat_while_statement: "WhileLoop",
  switch_statement: "SwitchBlock",
  control_transfer_statement: "Return",
  try_expression: "TryBlock",
  integer_literal: "integer_literal",
  hex_literal: "integer_literal",
  oct_literal: "integer_literal",
  bin_literal: "integer_literal",
  real_literal: "float_literal",
  boolean_literal: "boolean_literal",
  line_string_literal: "string_literal",
  multi_line_string_literal: "string_literal",
  raw_string_literal: "string_literal",
  regex_literal: "regex_literal",
  array_literal: "ArrayLiteral",
  dictionary_literal: "ObjectLiteral",
  tuple_expression: "TupleLiteral",
  lambda_literal: "Closure",
  simple_identifier: "identifier",
  type_identifier: "TypeIdentifier",
  identifier: "identifier",
  user_type: "TypeIdentifier",
  type_annotation: "TypeAnnotation",
  type_arguments: "TypeArguments",
  type_parameters: "TypeParameters",
  array_type: "ArrayType",
  tuple_type: "TupleType",
  function_type: "FunctionType",
  navigation_expression: "MemberAccess",
  value_arguments: "Arguments",
  value_argument: "Argument",
  comment: "Comment",
};

export class SwiftExtractor implements LanguageExtractor {
  readonly language = "swift";
  readonly extensions = ["swift"];
  readonly labelFallbackTypes = new Set(["property_declaration"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // Classes, functions and enum entries name their subject in a `name`
    // field. For properties the field points at the pattern node, which can
    // wrap the identifier; use the identifier itself.
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      if (nameNode.type === "pattern") {
        const id = nameNode.namedChildren.find((c) => c.type === "simple_identifier");
        if (id) return source.slice(id.startIndex, id.endIndex);
      }
      return source.slice(nameNode.startIndex, nameNode.endIndex);
    }

    return undefined;
  }
}
