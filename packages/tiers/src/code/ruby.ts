/**
 * Ruby language extractor.
 *
 * Maps tree-sitter-ruby node types to canonical concepts.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  program: "file",
  class: "Class",
  module: "Module",
  method: "Method",
  singleton_method: "Method",
  call: "CallExpression",
  element_reference: "IndexAccess",
  assignment: "Assignment",
  operator_assignment: "AugmentedAssignment",
  unary: "UnaryOp",
  if: "IfBlock",
  unless: "IfBlock",
  if_modifier: "IfBlock",
  unless_modifier: "IfBlock",
  while: "WhileLoop",
  until: "WhileLoop",
  while_modifier: "WhileLoop",
  until_modifier: "WhileLoop",
  for: "ForLoop",
  case: "SwitchBlock",
  begin: "TryBlock",
  rescue: "CatchClause",
  return: "Return",
  break: "Break",
  next: "Continue",
  yield: "Yield",
  lambda: "Lambda",
  block: "Block",
  do_block: "Block",
  block_body: "Block",
  body_statement: "Block",
  method_parameters: "Parameters",
  block_parameters: "Parameters",
  argument_list: "Arguments",
  string: "string_literal",
  string_content: "string_literal",
  integer: "integer_literal",
  float: "float_literal",
  regex: "regex_literal",
  simple_symbol: "Symbol",
  hash_key_symbol: "Symbol",
  array: "ArrayLiteral",
  hash: "ObjectLiteral",
  pair: "KeyValuePair",
  range: "Range",
  constant: "Constant",
  identifier: "identifier",
  instance_variable: "Variable",
  class_variable: "Variable",
  global_variable: "Variable",
  comment: "Comment",
};

export class RubyExtractor implements LanguageExtractor {
  readonly language = "ruby";
  readonly extensions = ["rb"];
  readonly labelFallbackTypes = new Set(["instance_variable"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // Classes, modules and methods all name their subject in a `name` field.
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // Instance variables carry no field at all; the node text is the name.
    if (node.type === "instance_variable") {
      return source.slice(node.startIndex, node.endIndex);
    }

    return undefined;
  }
}
