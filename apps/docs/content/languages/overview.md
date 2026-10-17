# Language support

The full native build links Tree-sitter grammars and semantic mappings for JavaScript, TypeScript/TSX, Python, Rust, Go, C, C++, Java, Ruby, PHP, Swift, Kotlin, C#, Scala, Lua, and shell. Run `differens languages` for the actual compiled build's extensions and levels.

Semantic mappings turn grammar kinds into concepts such as `Function`, `Class`, `Method`, `Import`, `Variable`, `Struct`, and `Trait`. Unmapped grammar nodes retain their raw CST kind. A future grammar-only registration can provide generic structure without a custom semantic mapping.

| Language | Examples |
| --- | --- |
| JavaScript / TypeScript / TSX | functions, methods, classes, interfaces, imports, exports, variables |
| Python | functions, classes, imports, decorators, assignments |
| Rust | functions, structs, enums, traits, impls, modules, imports |
| Go | functions, methods, structs, interfaces, variables |
| C / C++ | functions, structs, classes, namespaces, includes |
| Java | classes, methods, constructors, packages, imports |
| Ruby / PHP | methods, classes, modules/namespaces, declarations |
| Swift / Kotlin | functions, classes, properties, type aliases |
| C# / Scala | classes, namespaces/packages, methods/definitions, imports |
| Lua / Shell | functions, assignments, calls/commands, control flow |

A code-classified extension without a registered grammar uses raw lines. This includes unsupported composite formats and other extensions shown by classification alone. Header, CSS/SQL, Vue/Svelte/Astro, and other coverage should be checked against `languages` rather than inferred from the filename.

The examples on the language pages were checked against the native CLI. Each page lists concept mappings and known limits. Semantic diffing identifies syntax/declaration changes; it does not prove behavioral equivalence or implement a compiler's type system.

For new grammar or concept mappings, see [contributing](/guides/contributing.html). For non-code formats, see [tier adapters](/languages/tiers.html).

## Semantic concepts and raw grammar kinds

The code tier is T5. `differens languages` labels the full build's registered
languages as `semantic, L6`: these grammars have mappings to concepts such as
`Function`, `Class`, and `Import`. T5 and L6 describe different things; L6 is not
a seventh content tier.

Within a supported grammar, an unmapped CST kind keeps its raw grammar name.
A future grammar-only registration could provide generic L5 coverage, but the
current full build lists semantic mappings for all its registered languages.
An arbitrary grammar is not discovered or downloaded at runtime.

```bash
differens languages
```

```text
supported languages:

  javascript (semantic, L6): js, mjs, cjs, jsx
  typescript (semantic, L6): ts, mts, cts, tsx
  python (semantic, L6): py
  rust (semantic, L6): rs
  go (semantic, L6): go
  c (semantic, L6): c
  cpp (semantic, L6): cpp
  java (semantic, L6): java
  ruby (semantic, L6): rb
  php (semantic, L6): php
  swift (semantic, L6): swift
  kotlin (semantic, L6): kt
  csharp (semantic, L6): cs
  scala (semantic, L6): scala
  lua (semantic, L6): lua
  bash (semantic, L6): sh, bash, zsh

all other text files: raw (L1 line diff)
binary files: hash only (L0)
```

## How extractors recover names

The native mappings are Rust functions in
`crates/differens-tiers/src/code/concepts.rs` and `labels.rs`. Tree-sitter supplies
the syntax tree; these functions choose concepts and labels. There is no public
JavaScript `LanguageExtractor` interface in the Rust workspace.

Most names come from a grammar's `name` field. C/C++ declarations follow a
possibly nested declarator, Python assignments read their left-hand expression,
and Kotlin uses identifier recovery where its grammar omits field names. Go
methods also carry receiver identity so same-named methods remain distinguishable.

## Read the language examples

| Page | Includes |
| --- | --- |
| [TypeScript / JavaScript](/languages/typescript.html) | Functions, exports, parameters, and cross-file refactoring |
| [Python](/languages/python.html) | Decorated definitions, class assignments, and module moves |
| [Rust](/languages/rust.html) | Item renames, structs, traits, and attributes |
| [Go](/languages/go.html) | Receiver methods and helper extraction |
| [C](/languages/c.html), [C++](/languages/cpp.html) | Declarators, functions, classes, and templates |
| [Java](/languages/java.html), [C#](/languages/csharp.html) | Classes, methods, fields, and imports |
| [Ruby](/languages/ruby.html), [PHP](/languages/php.html) | Methods, classes, and language-specific declarations |
| [Swift](/languages/swift.html), [Kotlin](/languages/kotlin.html) | Functions, properties, and type aliases |
| [Scala](/languages/scala.html) | Classes, objects, and definitions |
| [Lua](/languages/lua.html), [Shell](/languages/bash.html) | Functions, assignments, and calls |

## Add support

Pin and link a grammar, register its extensions, add semantic mappings and label
recovery, then add valid, malformed, Unicode, rename, and move cases. The
[contributor guide](/guides/contributing.html#adding-a-language-extractor) lists
the native source files and checks.
