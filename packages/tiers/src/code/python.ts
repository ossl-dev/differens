/**
 * Python language extractor.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  module: "file",
  function_definition: "Function",
  class_definition: "Class",
  decorated_definition: "DecoratedDef",
  import_statement: "Import",
  import_from_statement: "Import",
  future_import_statement: "Import",
  if_statement: "IfBlock",
  elif_clause: "ElifBlock",
  else_clause: "ElseBlock",
  for_statement: "ForLoop",
  while_statement: "WhileLoop",
  try_statement: "TryBlock",
  except_clause: "ExceptClause",
  finally_clause: "FinallyClause",
  with_statement: "WithBlock",
  match_statement: "MatchBlock",
  case_clause: "CaseClause",
  return_statement: "Return",
  raise_statement: "Raise",
  assert_statement: "Assert",
  yield_statement: "Yield",
  string: "string_literal",
  integer: "integer_literal",
  float: "float_literal",
  true: "boolean_literal",
  false: "boolean_literal",
  none: "null_literal",
  list: "ListLiteral",
  tuple: "TupleLiteral",
  dictionary: "DictLiteral",
  set: "SetLiteral",
  list_comprehension: "ListComp",
  dictionary_comprehension: "DictComp",
  set_comprehension: "SetComp",
  generator_expression: "GeneratorExpr",
  call: "CallExpression",
  attribute: "AttributeAccess",
  subscript: "SubscriptAccess",
  assignment: "Assignment",
  augmented_assignment: "AugmentedAssignment",
  binary_operator: "BinaryOp",
  unary_operator: "UnaryOp",
  boolean_operator: "BooleanOp",
  comparison_operator: "ComparisonOp",
  lambda: "Lambda",
  conditional_expression: "TernaryOp",
  named_expression: "WalrusOp",
  keyword_argument: "KeywordArg",
  default_parameter: "DefaultParam",
  list_splat: "StarArg",
  dictionary_splat: "DoubleStarArg",
  identifier: "identifier",
  type: "TypeAnnotation",
  generic_type: "GenericType",
  union_type: "UnionType",
  expression_statement: "Expression",
  block: "Block",
  parameters: "Parameters",
  argument_list: "Arguments",
  string_content: "string_content",
  interpolation: "fstring_interpolation",
  comment: "Comment",
  decorator: "Decorator",
  pair: "KeyValuePair",
  slice: "Slice",
};

export class PythonExtractor implements LanguageExtractor {
  readonly language = "python";
  readonly extensions = ["py"];

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    return undefined;
  }
}
