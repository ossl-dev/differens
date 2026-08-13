/**
 * Scala language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  compilation_unit: "file",
  package_clause: "Namespace",
  package_identifier: "PackageIdentifier",
  import_declaration: "Import",
  class_definition: "Class",
  trait_definition: "Trait",
  object_definition: "SingletonObject",
  function_definition: "Function",
  val_definition: "Constant",
  var_definition: "Variable",
  parameters: "Parameters",
  parameter: "Parameter",
  class_parameters: "Parameters",
  class_parameter: "Parameter",
  template_body: "Block",
  block: "Block",
  if_expression: "IfBlock",
  while_expression: "WhileLoop",
  for_expression: "ForLoop",
  match_expression: "MatchBlock",
  case_block: "Block",
  case_clause: "CaseClause",
  catch_clause: "CatchClause",
  try_expression: "TryBlock",
  throw_expression: "Throw",
  return_statement: "Return",
  call_expression: "CallExpression",
  instance_expression: "NewExpression",
  arguments: "Arguments",
  infix_expression: "BinaryOp",
  parenthesized_expression: "Parenthesized",
  string: "string_literal",
  integer_literal: "integer_literal",
  float_literal: "float_literal",
  boolean_literal: "boolean_literal",
  null_literal: "null_literal",
  unit: "unit_literal",
  identifier: "identifier",
  type_identifier: "TypeIdentifier",
  comment: "Comment",
};

export class ScalaExtractor implements LanguageExtractor {
  readonly language = "scala";
  readonly extensions = ["scala"];
  readonly labelFallbackTypes = new Set(["val_definition", "var_definition"]);

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // val/var definitions carry their name in the "pattern" field
    if (node.type === "val_definition" || node.type === "var_definition") {
      const pattern = node.childForFieldName("pattern");
      if (pattern) return source.slice(pattern.startIndex, pattern.endIndex);
      const identifier = node.namedChildren.find((c) => c.type === "identifier");
      if (identifier) return source.slice(identifier.startIndex, identifier.endIndex);
    }

    return undefined;
  }
}
