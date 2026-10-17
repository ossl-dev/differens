# C++

The C++ extractor maps tree-sitter C++ CST nodes to canonical concepts. Class and namespace names come from the standard `name` field; function names are recovered through the declarator chain.

## Detected concepts

| tree-sitter node type | Canonical concept |
|---|---|
| `function_definition` | Function |
| `class_specifier` | Class |
| `struct_specifier` | Struct |
| `enum_specifier` | Enum |
| `namespace_definition` | Namespace |
| `declaration` / `field_declaration` | Variable |
| `template_declaration` | TemplateDeclaration |
| `template_parameter_list` | TypeParameters |
| `parameter_declaration` | Parameter |
| `preproc_include` | PreprocInclude |
| `access_specifier` | AccessSpecifier |

## Example

Renaming a method:

```cpp old.cpp
class Counter { int total(int n) { return n + 1; } };
```

```cpp new.cpp
class Counter { int sum(int n) { return n + 1; } };
```

Running `differens old.cpp new.cpp`:

```text
  ~ renamed function `total` to `sum` in class `Counter`
  ~ changed function `sum` (`total` → `sum`)
```

## Example: change the body

Keep the declaration name and change what it does:

<CodeGroup>

```cpp body-before.cpp
class Counter { int total(int n) { return n + 1; } };
```

```cpp body-after.cpp
class Counter { int total(int n) { return n + 2; } };
```

</CodeGroup>

```bash
differens body-before.cpp body-after.cpp
```

```text
  ~ changed function `total` (`1` → `2`)
```

The report groups the value edit under its containing declaration. Use
`--format=json` to inspect the underlying action and context, or `--format=llm`
for a compact report with source locations.

## Known limitations

- Preprocessor macros are tokens, not structure; conditional compilation does not expand before diffing.
- Templates are diffed as written. The extractor does not expand them or compare compiler-generated instantiations.
