/**
 * C# language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  compilation_unit: "file",
  using_directive: "Import",
  namespace_declaration: "Namespace",
  class_declaration: "Class",
  method_declaration: "Method",
  field_declaration: "FieldDecl",
  variable_declaration: "Variable",
  parameter_list: "Parameters",
  parameter: "Parameter",
  argument_list: "Arguments",
  declaration_list: "Block",
  block: "Block",
  if_statement: "IfBlock",
  else_clause: "ElseBlock",
  for_statement: "ForLoop",
  foreach_statement: "ForLoop",
  while_statement: "WhileLoop",
  do_statement: "DoLoop",
  switch_statement: "SwitchBlock",
  switch_body: "Block",
  return_statement: "Return",
  expression_statement: "Expression",
  invocation_expression: "CallExpression",
  object_creation_expression: "NewExpression",
  member_access_expression: "MemberAccess",
  binary_expression: "BinaryOp",
  conditional_expression: "TernaryOp",
  assignment_expression: "Assignment",
  prefix_unary_expression: "UnaryOp",
  postfix_unary_expression: "UnaryOp",
  parenthesized_expression: "Parenthesized",
  integer_literal: "integer_literal",
  real_literal: "float_literal",
  string_literal: "string_literal",
  char_literal: "char_literal",
  boolean_literal: "boolean_literal",
  null_literal: "null_literal",
  identifier: "identifier",
  predefined_type: "TypeIdentifier",
  implicit_type: "TypeIdentifier",
  comment: "Comment",
};

export class CSharpExtractor implements LanguageExtractor {
  readonly language = "csharp";
  readonly extensions = ["cs"];
  readonly labelFallbackTypes = new Set(["variable_declaration", "field_declaration"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // Variable and field declarations carry their name on a nested
    // variable_declarator (for fields the declarator sits one level deeper,
    // inside the declaration's variable_declaration child).
    if (node.type === "variable_declaration" || node.type === "field_declaration") {
      const declarator = node.descendantsOfType("variable_declarator")[0];
      const declName = declarator?.childForFieldName("name");
      if (declName) return source.slice(declName.startIndex, declName.endIndex);
    }

    return undefined;
  }
}
