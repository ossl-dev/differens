/**
 * Bash language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  program: "file",
  function_definition: "Function",
  command: "CallExpression",
  command_name: "identifier",
  variable_assignment: "Variable",
  variable_name: "identifier",
  simple_expansion: "Variable",
  declaration_command: "Variable",
  compound_statement: "Block",
  do_group: "Block",
  if_statement: "IfBlock",
  test_command: "Expression",
  for_statement: "ForLoop",
  while_statement: "WhileLoop",
  case_statement: "SwitchBlock",
  case_item: "CaseClause",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  test_operator: "BinaryOp",
  string: "string_literal",
  number: "number_literal",
  comment: "Comment",
};

export class BashExtractor implements LanguageExtractor {
  readonly language = "bash";
  readonly extensions = ["sh", "bash", "zsh"];

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // Every named construct (functions, assignments, commands) keeps its name
    // in a plain "name" field, so no fallback types are needed.
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    return undefined;
  }
}
