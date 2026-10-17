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
