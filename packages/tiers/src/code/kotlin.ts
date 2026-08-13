/**
 * Kotlin language extractor.
 *
 * Maps tree-sitter-kotlin node types to canonical concepts. The Kotlin
 * grammar declares no field names at all, so every label must be pulled from
 * the first identifier-like child.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  source_file: "file",
  class_declaration: "Class",
  function_declaration: "Function",
  anonymous_function: "Function",
  property_declaration: "Variable",
  variable_declaration: "Variable",
  type_alias: "TypeDef",
  import_header: "Import",
  package_header: "Namespace",
  parameter: "Parameter",
  class_parameter: "Parameter",
  function_value_parameters: "Parameters",
  lambda_parameters: "Parameters",
  value_arguments: "Arguments",
  value_argument: "Argument",
  call_expression: "CallExpression",
  constructor_invocation: "NewExpression",
  assignment: "Assignment",
  prefix_expression: "UnaryOp",
  postfix_expression: "UnaryOp",
  additive_expression: "BinaryOp",
  multiplicative_expression: "BinaryOp",
  comparison_expression: "BinaryOp",
  equality_expression: "BinaryOp",
  conjunction_expression: "BinaryOp",
  disjunction_expression: "BinaryOp",
  infix_expression: "BinaryOp",
  elvis_expression: "BinaryOp",
  range_expression: "Range",
  jump_expression: "Return",
  if_expression: "IfBlock",
  for_statement: "ForLoop",
  while_statement: "WhileLoop",
  do_while_statement: "WhileLoop",
  when_expression: "SwitchBlock",
  class_body: "Block",
  statements: "Block",
  function_body: "Block",
  control_structure_body: "Block",
  string_literal: "string_literal",
  string_content: "string_literal",
  integer_literal: "integer_literal",
  long_literal: "integer_literal",
  unsigned_literal: "integer_literal",
  real_literal: "float_literal",
  character_literal: "char_literal",
  boolean_literal: "boolean_literal",
  simple_identifier: "identifier",
  type_identifier: "TypeIdentifier",
  identifier: "identifier",
  user_type: "TypeIdentifier",
  function_type: "FunctionType",
  type_arguments: "TypeArguments",
  type_parameters: "TypeParameters",
  parenthesized_expression: "Parenthesized",
  collection_literal: "ArrayLiteral",
  object_literal: "ObjectLiteral",
  lambda_literal: "Closure",
  try_expression: "TryBlock",
  line_comment: "Comment",
  multiline_comment: "Comment",
};

function findIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (const child of node.namedChildren) {
    if (
      child.type === "simple_identifier" ||
      child.type === "type_identifier" ||
      child.type === "identifier"
    ) {
      return child;
    }
  }
  // Property declarations wrap their name in a variable_declaration one
  // level down, past the val/var keyword.
  for (const child of node.namedChildren) {
    if (child.type === "variable_declaration") {
      const inner = findIdentifier(child);
      if (inner) return inner;
    }
  }
  return undefined;
}

export class KotlinExtractor implements LanguageExtractor {
  readonly language = "kotlin";
  readonly extensions = ["kt"];
  readonly labelFallbackTypes = new Set([
    "class_declaration",
    "function_declaration",
    "property_declaration",
    "variable_declaration",
    "type_alias",
    "parameter",
    "class_parameter",
    "enum_entry",
  ]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // The grammar declares no fields, so nothing is read automatically; the
    // label always comes from the first identifier-like child.
    const name = findIdentifier(node);
    if (name) return source.slice(name.startIndex, name.endIndex);

    return undefined;
  }
}
