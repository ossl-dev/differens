/**
 * C language extractor.
 *
 * Maps tree-sitter-c node types to canonical concepts. C has no `name`
 * fields at all, so every label comes from the declarator chains in
 * labelFallbackTypes.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  translation_unit: "file",
  function_definition: "Function",
  function_declarator: "Function",
  declaration: "Variable",
  init_declarator: "Variable",
  field_declaration: "Variable",
  struct_specifier: "Struct",
  union_specifier: "Union",
  enum_specifier: "Enum",
  field_declaration_list: "StatementBlock",
  parameter_declaration: "Parameter",
  parameter_list: "Parameters",
  compound_statement: "Block",
  return_statement: "Return",
  if_statement: "IfBlock",
  for_statement: "ForLoop",
  while_statement: "WhileLoop",
  switch_statement: "SwitchBlock",
  preproc_include: "PreprocInclude",
  system_lib_string: "Import",
  storage_class_specifier: "StorageClass",
  call_expression: "CallExpression",
  assignment_expression: "Assignment",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  parenthesized_expression: "Parenthesized",
  string_literal: "string_literal",
  number_literal: "number_literal",
  char_literal: "char_literal",
  identifier: "identifier",
  type_identifier: "TypeIdentifier",
  field_identifier: "FieldIdentifier",
  primitive_type: "TypeIdentifier",
  comment: "Comment",
};

export class CExtractor implements LanguageExtractor {
  readonly language = "c";
  readonly extensions = ["c"];
  readonly labelFallbackTypes = new Set([
    "function_definition",
    "declaration",
    "field_declaration",
  ]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    switch (node.type) {
      // function_definition -> declarator (function_declarator) -> declarator (identifier)
      case "function_definition": {
        const name = node.childForFieldName("declarator")?.childForFieldName("declarator");
        if (name) return source.slice(name.startIndex, name.endIndex);
        break;
      }
      // declaration -> declarator (init_declarator | function_declarator) -> declarator (identifier)
      case "declaration": {
        let declarator = node.childForFieldName("declarator");
        if (declarator?.type === "init_declarator" || declarator?.type === "function_declarator") {
          declarator = declarator.childForFieldName("declarator");
        }
        if (declarator) return source.slice(declarator.startIndex, declarator.endIndex);
        break;
      }
      // field_declaration -> declarator (field_identifier)
      case "field_declaration": {
        const declarator = node.childForFieldName("declarator");
        if (declarator) return source.slice(declarator.startIndex, declarator.endIndex);
        break;
      }
    }

    return undefined;
  }
}
