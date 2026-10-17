#![allow(
    unsafe_code,
    reason = "isolated binding to checked-in generated tree-sitter Swift C grammar"
)]
//! Exact tree-sitter-swift 0.7.1 grammar, generated upstream and frozen here.
use tree_sitter_language::LanguageFn;
unsafe extern "C" {
    fn tree_sitter_swift() -> *const ();
}
// SAFETY: The linked symbol is the checked-in upstream generated Swift parser,
// returning its immutable process-lifetime TSLanguage descriptor.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_swift) };
