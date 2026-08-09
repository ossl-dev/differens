/**
 * TypeScript/JavaScript language extractor.
 *
 * Maps tree-sitter TS/JS node types to canonical concepts.
 */

import type Parser from "tree-sitter";
import type { LanguageExtractor } from "./extractor";

const CONCEPT_MAP: Record<string, string> = {
  program: "file",
  function_declaration: "Function",
  function_expression: "Function",
  arrow_function: "Function",
  method_definition: "Method",
  class_declaration: "Class",
  class_expression: "Class",
  interface_declaration: "Interface",
  type_alias_declaration: "TypeDef",
  enum_declaration: "Enum",
  variable_declaration: "Variable",
  lexical_declaration: "Variable",
  import_statement: "Import",
  export_statement: "Export",
  export_default: "Export",
  try_statement: "TryBlock",
  catch_clause: "CatchClause",
  if_statement: "IfBlock",
  for_statement: "ForLoop",
  for_in_statement: "ForLoop",
  while_statement: "WhileLoop",
  switch_statement: "SwitchBlock",
  return_statement: "Return",
  throw_statement: "Throw",
  string: "string_literal",
  number: "number_literal",
  template_string: "template_literal",
  regex: "regex_literal",
  true: "boolean_literal",
  false: "boolean_literal",
  null: "null_literal",
  undefined: "undefined_literal",
  object: "ObjectLiteral",
  array: "ArrayLiteral",
  pair: "KeyValuePair",
  property_identifier: "Property",
  call_expression: "CallExpression",
  new_expression: "NewExpression",
  member_expression: "MemberAccess",
  subscript_expression: "IndexAccess",
  assignment_expression: "Assignment",
  binary_expression: "BinaryOp",
  unary_expression: "UnaryOp",
  ternary_expression: "TernaryOp",
  await_expression: "Await",
  yield_expression: "Yield",
  jsx_element: "JSXElement",
  jsx_self_closing_element: "JSXElement",
  jsx_expression: "JSXExpression",
  jsx_attribute: "JSXAttribute",
  jsx_text: "JSXText",
  jsx_opening_element: "JSXOpening",
  jsx_closing_element: "JSXClosing",
  type_annotation: "TypeAnnotation",
  type_arguments: "TypeArguments",
  type_parameters: "TypeParameters",
  optional_parameter: "OptionalParam",
  required_parameter: "RequiredParam",
  rest_parameter: "RestParam",
  decorator: "Decorator",
  comment: "Comment",
  statement_block: "Block",
  expression_statement: "Expression",
  parenthesized_expression: "Parenthesized",
  named_imports: "NamedImports",
  namespace_import: "NamespaceImport",
  identifier: "identifier",
  property_signature: "PropertySignature",
  call_signature: "CallSignature",
  construct_signature: "ConstructSignature",
  index_signature: "IndexSignature",
  method_signature: "MethodSignature",
};

export class TypeScriptExtractor implements LanguageExtractor {
  readonly language = "typescript";
  readonly extensions = ["js", "mjs", "cjs", "jsx", "ts", "tsx"];

  extractConcept(nodeType: string): string {
    return CONCEPT_MAP[nodeType] ?? nodeType;
  }

  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined {
    // Named nodes often have a name/identifier child
    const nameNode = node.childForFieldName("name");
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);

    // For variable declarations, check declarator children
    if (node.type === "variable_declaration" || node.type === "lexical_declaration") {
      for (const child of node.namedChildren) {
        if (child.type === "variable_declarator") {
          const declName = child.childForFieldName("name");
          if (declName) return source.slice(declName.startIndex, declName.endIndex);
        }
      }
    }

    return undefined;
  }

  isOrdered(nodeKind: string): boolean {
    // Import and export order usually doesn't matter semantically
    if (nodeKind === "Import" || nodeKind === "Export") return false;
    // Most structural elements are ordered
    return true;
  }
}
