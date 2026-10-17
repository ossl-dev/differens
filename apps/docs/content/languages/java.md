# Java

The Java extractor maps tree-sitter Java CST nodes to canonical concepts. Class and method names come from the standard `name` field; variable names are recovered from the declarator.

## Detected concepts

| tree-sitter node type | Canonical concept |
|---|---|
| `class_declaration` | Class |
| `interface_declaration` | Interface |
| `enum_declaration` | Enum |
| `method_declaration` | Method |
| `constructor_declaration` | Constructor |
| `package_declaration` | Namespace |
| `import_declaration` | Import |
| `field_declaration` | Variable |
| `local_variable_declaration` | Variable |
| `formal_parameters` | Parameters |
| `decimal_integer_literal` | integer_literal |
| `method_invocation` | CallExpression |

## Example

Renaming a method:

```java old.java
class Counter { int total(int n) { return n + 1; } }
```

```java new.java
class Counter { int sum(int n) { return n + 1; } }
```

Running `differens old.java new.java`:

```text
  ~ renamed method `total` to `sum` in class `Counter`
```

## Example: change the body

Keep the declaration name and change what it does:

<CodeGroup>

```java body-before.java
class Counter { int total(int n) { return n + 1; } }
```

```java body-after.java
class Counter { int total(int n) { return n + 2; } }
```

</CodeGroup>

```bash
differens body-before.java body-after.java
```

```text
  ~ changed method `total` (`1` → `2`)
```

The report groups the value edit under its containing declaration. Use
`--format=json` to inspect the underlying action and context, or `--format=llm`
for a compact report with source locations.

## Known limitations

- Lambda bodies are diffed structurally; a lambda extracted to a named method reports as an addition plus a body change, not an extraction.
- Annotations are structure: adding an annotation reports as an insert, not an "annotated" action.
