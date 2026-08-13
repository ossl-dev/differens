/**
 * PHP language extractor.
 *
 * Maps tree-sitter-php node types to canonical concepts.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  program: "file",
  class_declaration: "Class",
  interface_declaration: "Interface",
  trait_declaration: "Trait",
  enum_declaration: "Enum",
  method_declaration: "Method",
  function_definition: "Function",
  anonymous_function: "Function",
  arrow_function: "Function",
  namespace_definition: "Namespace",
  namespace_name: "Namespace",
  namespace_use_declaration: "Import",
  namespace_use_clause: "Import",
  use_declaration: "Import",
  property_declaration: "Variable",
  const_declaration: "Constant",
  static_variable_declaration: "Variable",
  return_statement: "Return",
  break_statement: "Break",
  continue_statement: "Continue",
  if_statement: "IfBlock",
  for_statement: "ForLoop",
  foreach_statement: "ForLoop",
  while_statement: "WhileLoop",
  do_statement: "WhileLoop",
  switch_statement: "SwitchBlock",
  try_statement: "TryBlock",
  catch_clause: "CatchClause",
  match_expression: "MatchBlock",
  throw_expression: "Throw",
  yield_expression: "Yield",
  function_call_expression: "CallExpression",
  member_call_expression: "MethodCall",
  nullsafe_member_call_expression: "MethodCall",
  scoped_call_expression: "CallExpression",
  object_creation_expression: "NewExpression",
  member_access_expression: "MemberAccess",
  nullsafe_member_access_expression: "MemberAccess",
  scoped_property_access_expression: "MemberAccess",
  subscript_expression: "IndexAccess",
  assignment_expression: "Assignment",
  augmented_assignment_expression: "AugmentedAssignment",
  reference_assignment_expression: "Assignment",
  binary_expression: "BinaryOp",
  unary_op_expression: "UnaryOp",
  conditional_expression: "TernaryOp",
  string: "string_literal",
  encapsed_string: "string_literal",
  heredoc: "string_literal",
  nowdoc: "string_literal",
  string_content: "string_literal",
  integer: "integer_literal",
  float: "float_literal",
  boolean: "boolean_literal",
  null: "null_literal",
  array_creation_expression: "ArrayLiteral",
  pair: "KeyValuePair",
  parenthesized_expression: "Parenthesized",
  expression_statement: "Expression",
  compound_statement: "Block",
  declaration_list: "Block",
  formal_parameters: "Parameters",
  arguments: "Arguments",
  argument: "Argument",
  simple_parameter: "Parameter",
  variadic_parameter: "Parameter",
  primitive_type: "TypeIdentifier",
  named_type: "TypeIdentifier",
  qualified_name: "TypeIdentifier",
  name: "identifier",
  variable_name: "Variable",
  comment: "Comment",
};

export class PhpExtractor implements LanguageExtractor {
  readonly language = "php";
  readonly extensions = ["php"];
  readonly labelFallbackTypes = new Set(["property_declaration"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // Classes, methods, functions and namespaces name their subject in a
    // `name` field.
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // Property declarations have no name field; their property_element child
    // carries the variable_name in its name field.
    if (node.type === "property_declaration") {
      const element = node.namedChildren.find((c) => c.type === "property_element");
      const name = element?.childForFieldName("name");
      if (name) return source.slice(name.startIndex, name.endIndex);
    }

    return undefined;
  }
}
