/**
 * Lua language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  chunk: "file",
  function_declaration: "Function",
  variable_declaration: "Variable",
  assignment_statement: "Assignment",
  table_constructor: "ObjectLiteral",
  field: "KeyValuePair",
  function_call: "CallExpression",
  method_index_expression: "MethodCall",
  dot_index_expression: "MemberAccess",
  binary_expression: "BinaryOp",
  if_statement: "IfBlock",
  else_statement: "ElseBlock",
  while_statement: "WhileLoop",
  for_statement: "ForLoop",
  repeat_statement: "RepeatLoop",
  return_statement: "Return",
  parameters: "Parameters",
  arguments: "Arguments",
  block: "Block",
  number: "number_literal",
  string: "string_literal",
  boolean: "boolean_literal",
  true: "boolean_literal",
  false: "boolean_literal",
  nil: "null_literal",
  identifier: "identifier",
  comment: "Comment",
};

export class LuaExtractor implements LanguageExtractor {
  readonly language = "lua";
  readonly extensions = ["lua"];
  readonly labelFallbackTypes = new Set(["variable_declaration"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // The grammar puts a "local_declaration" field on the enclosing block's
    // edge to the declaration, so the name must be hunted inside: it lives on
    // the variable_list's "name" field.
    if (node.type === "variable_declaration") {
      const variableList = node.descendantsOfType("variable_list")[0];
      const declName = variableList?.childForFieldName("name");
      if (declName) return source.slice(declName.startIndex, declName.endIndex);
    }

    return undefined;
  }
}
