//! Frozen grammar entry points. No runtime downloads or parser generation.
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

macro_rules! grammars {
    ($( $symbol:ident ),+ $(,)?) => {
        unsafe extern "C" { $(fn $symbol() -> *const ();)+ }
        fn language(extension: &str) -> Option<LanguageFn> {
            // SAFETY: Each symbol is compiled from its checked-in upstream
            // generated parser.c and returns a static TSLanguage pointer.
            Some(unsafe { match extension {
                "js" | "mjs" | "cjs" | "jsx" => LanguageFn::from_raw(tree_sitter_javascript),
                "ts" | "mts" | "cts" => LanguageFn::from_raw(tree_sitter_typescript),
                "tsx" => LanguageFn::from_raw(tree_sitter_tsx),
                "py" => LanguageFn::from_raw(tree_sitter_python),
                "rs" => LanguageFn::from_raw(tree_sitter_rust),
                "go" => LanguageFn::from_raw(tree_sitter_go),
                "c" => LanguageFn::from_raw(tree_sitter_c),
                "cpp" => LanguageFn::from_raw(tree_sitter_cpp),
                "java" => LanguageFn::from_raw(tree_sitter_java),
                "rb" => LanguageFn::from_raw(tree_sitter_ruby),
                "php" => LanguageFn::from_raw(tree_sitter_php),
                "swift" => differens_grammar_swift::LANGUAGE,
                "kt" => LanguageFn::from_raw(tree_sitter_kotlin),
                "cs" => LanguageFn::from_raw(tree_sitter_c_sharp),
                "scala" => LanguageFn::from_raw(tree_sitter_scala),
                "lua" => LanguageFn::from_raw(tree_sitter_lua),
                "sh" | "bash" | "zsh" => LanguageFn::from_raw(tree_sitter_bash),
                _ => return None,
            }})
        }
    };
}
grammars!(
    tree_sitter_javascript,
    tree_sitter_typescript,
    tree_sitter_tsx,
    tree_sitter_python,
    tree_sitter_rust,
    tree_sitter_go,
    tree_sitter_c,
    tree_sitter_cpp,
    tree_sitter_java,
    tree_sitter_ruby,
    tree_sitter_php,
    tree_sitter_kotlin,
    tree_sitter_c_sharp,
    tree_sitter_scala,
    tree_sitter_lua,
    tree_sitter_bash
);

pub(super) fn get(extension: &str) -> Option<Language> {
    language(extension).map(Language::new)
}
