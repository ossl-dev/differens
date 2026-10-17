# Tier pipeline

Classification picks an initial adapter from the file path. The router compares original bytes first, distinguishes missing files from empty files, and uses binary handling for invalid UTF-8. It does not walk every numbered tier in sequence.

| Tier | Input | Result |
| --- | --- | --- |
| T5 | Registered code dialect | Tree-sitter CST and semantic concepts |
| T4 | JSON/JSONC/JSON5, YAML, TOML, INI, ENV | Typed key/value tree |
| T3 | HTML/XML and related markup | Elements, attributes, text |
| T2 | Plain prose and selected extensionless documents | Word edits and paragraph moves |
| T1 | Other text, including Markdown | Raw line edits |
| T0 | Binary bytes | File-level changes or plugin result |

Code, data, and markup try their parser, then fall directly to raw lines on failure or analysis-budget exhaustion. A registered code grammar can produce generic structural concepts where a semantic mapping is absent. Extensions classified as code without a linked grammar use lines.

The shared sequence engine trims equal boundaries, uses exact LCS for small inputs, and bounded linear-space Myers for larger inputs. If work exceeds its limit, it retains a valid positional fallback instead of claiming an optimal sequence.

Data parsers retain scalar types, so `1` and `"1"` differ. YAML indentation is parsed by its format parser. Markup retains non-label attributes such as `href`. Binary comparisons retain original bytes, including invalid UTF-8.

Adapters build `differens_core::Tree` through validated `TreeBuilder` calls. Shared matching remains in the core; format-specific extraction remains in the tiers crate.
