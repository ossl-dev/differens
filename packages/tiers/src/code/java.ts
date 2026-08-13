/**
 * Java language extractor.
 *
 * Maps tree-sitter-java node types to canonical concepts. Class and method
 * names sit in `name` fields (automatic); variable names sit behind the
 * variable_declarator, handled by labelFallbackTypes.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  program: "file",
  package_declaration: "Namespace",
  import_declaration: "Import",
  class_declaration: "Class",
  interface_declaration: "Interface",
  enum_declaration: "Enum",
  annotation_type_declaration: "AnnotationType",
  method_declaration: "Method",
  constructor_declaration: "Constructor",
  field_declaration: "Variable",
  local_variable_declaration: "Variable",
  variable_declarator: "Variable",
  formal_parameters: "Parameters",
  class_body: "StatementBlock",
  block: "Block",
  if_statement: "IfBlock",
  for_statement: "ForLoop",
  enhanced_for_statement: "ForLoop",
  while_statement: "WhileLoop",
  switch_expression: "SwitchBlock",
  switch_statement: "SwitchBlock",
  return_statement: "Return",
  throw_statement: "Throw",
  string_literal: "string_literal",
  decimal_integer_literal: "integer_literal",
  decimal_floating_point_literal: "float_literal",
  true: "boolean_literal",
  false: "boolean_literal",
  null_literal: "null_literal",
  method_invocation: "CallExpression",
  object_creation_expression: "NewExpression",
  array_creation_expression: "ArrayLiteral",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  update_expression: "UnaryOp",
  assignment_expression: "Assignment",
  parenthesized_expression: "Parenthesized",
  expression_statement: "Expression",
  scoped_identifier: "Namespace",
  modifiers: "Modifier",
  type_list: "TypeParameters",
  identifier: "identifier",
  type_identifier: "TypeIdentifier",
  integral_type: "TypeIdentifier",
  floating_point_type: "TypeIdentifier",
  boolean_type: "TypeIdentifier",
  void_type: "TypeIdentifier",
  comment: "Comment",
};

export class JavaExtractor implements LanguageExtractor {
  readonly language = "java";
  readonly extensions = ["java"];
  readonly labelFallbackTypes = new Set(["local_variable_declaration", "field_declaration"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    if (node.type === "local_variable_declaration" || node.type === "field_declaration") {
      // declaration -> declarator (variable_declarator) -> name (identifier)
      const name = node.childForFieldName("declarator")?.childForFieldName("name");
      if (name) return source.slice(name.startIndex, name.endIndex);
    }

    return undefined;
  }
}
