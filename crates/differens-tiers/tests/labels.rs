#![cfg(feature = "code")]
//! Construct-level coverage of the original fifteen semantic extractors.
use differens_core::{NodeId, Tree};
use differens_tiers::parse_code;
fn assert_label(tree: &Tree, kind: &str, label: &str, extension: &str, source: &str) {
    assert!(
        (0..tree.len()).any(|i| {
            let node = tree.node(NodeId(i));
            node.kind == kind && node.label.as_deref() == Some(label)
        }),
        "{extension}: {kind} {label} missing in {source}"
    );
}
const DECLARATIONS: &[(&str, &str, &str, &str)] = &[
    (
        "ts",
        "export function parseConfig(raw: string) { return raw; }",
        "Function",
        "parseConfig",
    ),
    (
        "ts",
        "class Worker { run(): void { this.step(); } }",
        "Class",
        "Worker",
    ),
    (
        "ts",
        "class Worker { run(): void { this.step(); } }",
        "Method",
        "run",
    ),
    ("ts", "const timeout = 5;", "Variable", "timeout"),
    ("ts", "let count = 0;", "Variable", "count"),
    ("js", "var count = 0;", "Variable", "count"),
    (
        "py",
        "class Worker:\n    def run(self):\n        return 1\n",
        "Class",
        "Worker",
    ),
    (
        "py",
        "class Worker:\n    def run(self):\n        return 1\n",
        "Function",
        "run",
    ),
    ("rs", "type UserId = u64;", "TypeDef", "UserId"),
    ("rs", "struct Worker { value: u32 }", "Struct", "Worker"),
    (
        "go",
        "package main\ntype Worker struct {}\nfunc (w Worker) Run() {}",
        "Method",
        "Run",
    ),
    (
        "c",
        "int add(int a, int b) { return a + b; }",
        "Function",
        "add",
    ),
    ("c", "static int count = 0;", "Variable", "count"),
    ("c", "int count;", "Variable", "count"),
    ("c", "int run(void);", "Variable", "run"),
    ("c", "struct Point { int x; int y; };", "Struct", "Point"),
    ("c", "struct Point { int x; int y; };", "Variable", "x"),
    (
        "cpp",
        "namespace ns { int run() { return 1; } }",
        "Namespace",
        "ns",
    ),
    (
        "cpp",
        "namespace ns { int run() { return 1; } }",
        "Function",
        "run",
    ),
    ("cpp", "int count = 0;", "Variable", "count"),
    (
        "cpp",
        "class Worker { public: int run(); int value; };",
        "Class",
        "Worker",
    ),
    (
        "cpp",
        "class Worker { public: int run(); int value; };",
        "Variable",
        "run",
    ),
    (
        "cpp",
        "class Worker { public: int run(); int value; };",
        "Variable",
        "value",
    ),
    (
        "java",
        "class Worker { void run() { int count = 0; } }",
        "Method",
        "run",
    ),
    (
        "java",
        "class Worker { void run() { int count = 0; } }",
        "Variable",
        "count",
    ),
    ("java", "class Point { int x; }", "Variable", "x"),
    (
        "rb",
        "class Worker\n  def run\n    @name = 'a'\n  end\nend",
        "Class",
        "Worker",
    ),
    (
        "rb",
        "class Worker\n  def run\n    @name = 'a'\n  end\nend",
        "Variable",
        "@name",
    ),
    (
        "php",
        "<?php class Worker { public int $count = 0; }",
        "Class",
        "Worker",
    ),
    (
        "php",
        "<?php class Worker { public int $count = 0; }",
        "Variable",
        "$count",
    ),
    ("swift", "class Worker {}\n", "Class", "Worker"),
    (
        "swift",
        "class W {\n  var count = 0\n}\n",
        "Variable",
        "count",
    ),
    ("swift", "enum E {\n  case idle\n}\n", "Enum", "idle"),
    ("kt", "class Worker {}\n", "Class", "Worker"),
    ("kt", "val count = 0\n", "Variable", "count"),
    ("kt", "typealias Id = String\n", "TypeDef", "Id"),
    (
        "kt",
        "fun parse(other: String) = other\n",
        "Parameter",
        "other",
    ),
    ("kt", "class Worker(val count: Int)\n", "Parameter", "count"),
    (
        "cs",
        "class Worker { int Run(int n) { return n; } }",
        "Class",
        "Worker",
    ),
    (
        "cs",
        "class Worker { int Run(int n) { return n; } }",
        "Method",
        "Run",
    ),
    ("cs", "class Worker { int value; }", "FieldDecl", "value"),
    (
        "cs",
        "class Worker { void Run() { int count = 5; } }",
        "Variable",
        "count",
    ),
    (
        "scala",
        "class Worker { def run(times: Int): Int = times }",
        "Class",
        "Worker",
    ),
    (
        "scala",
        "class Worker { def run(times: Int): Int = times }",
        "Function",
        "run",
    ),
    (
        "scala",
        "class Worker { def run(times: Int): Int = { val result = times; result } }",
        "Constant",
        "result",
    ),
    ("scala", "object O { var x = 1 }", "Variable", "x"),
    (
        "lua",
        "function increment(step) return step end",
        "Function",
        "increment",
    ),
    ("lua", "local x = 5", "Variable", "x"),
    (
        "lua",
        "function increment(step) local total = 0; return total end",
        "Variable",
        "total",
    ),
    ("sh", "increment() { echo hi; }", "Function", "increment"),
    ("sh", "increment() { echo hi; }", "CallExpression", "echo"),
    ("sh", "x=5", "Variable", "x"),
];
#[test]
fn declaration_labels_survive_every_language_adapter() {
    for &(extension, source, kind, label) in DECLARATIONS {
        let tree = parse_code(source, extension, 50_000).unwrap();
        assert_label(&tree, kind, label, extension, source);
    }
}
#[test]
fn grammar_aliases_share_a_cache_without_conflating_dialects() {
    differens_tiers::clear_parse_cache();
    for (extension, alias, source) in [
        ("js", "mjs", "function run() {}"),
        ("js", "cjs", "function run() {}"),
        ("ts", "mts", "type Id = number;"),
        ("ts", "cts", "type Id = number;"),
        ("sh", "bash", "run() { echo hi; }"),
        ("sh", "zsh", "run() { echo hi; }"),
    ] {
        let first = parse_code(source, extension, 50_000).unwrap();
        let second = parse_code(source, alias, 50_000).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
    }
    let source = "class Worker {}";
    let java = parse_code(source, "java", 50_000).unwrap();
    let csharp = parse_code(source, "cs", 50_000).unwrap();
    assert!(!std::sync::Arc::ptr_eq(&java, &csharp));
}
#[test]
fn unsupported_code_keeps_line_labels_and_enforces_its_budget() {
    let tree = parse_code("p { color: red }\nbody {}", "css", 3).unwrap();
    assert_eq!(tree.node(tree.root()).label.as_deref(), Some("css"));
    assert_label(&tree, "line", "L1", "css", "p { color: red }");
    assert_eq!(
        tree.node(NodeId(0)).value.as_deref(),
        Some("p { color: red }")
    );
    assert!(matches!(
        parse_code("line1\nline2", "css", 2),
        Err(differens_tiers::ParseError::Budget)
    ));
}
