/**
 * LanguageExtractor interface.
 *
 * Each extractor maps tree-sitter CST node types to canonical concepts
 * and extracts labels (names) from nodes. This is the per-language
 * investment — a few dozen match arms, not a parser.
 */

import type Parser from "tree-sitter";

export interface LanguageExtractor {
  /** Language identifier, e.g. "typescript" */
  readonly language: string;
  /** File extensions this extractor handles */
  readonly extensions: string[];
  /** Map a tree-sitter node type to a canonical concept */
  extractConcept(nodeType: string): string;
  /** Extract the label (name) from a node if it has one */
  extractLabel(node: Parser.SyntaxNode, source: string): string | undefined;
  /** Whether child order matters for this node kind */
  isOrdered(nodeKind: string): boolean;
}
