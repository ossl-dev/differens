# Ruby

The Ruby extractor maps tree-sitter Ruby CST nodes to canonical concepts. Class and module names come from the `name` field on constants; method names from the `name` field on identifiers.

## Detected concepts

| tree-sitter node type | Canonical concept |
|---|---|
| `class` | Class |
| `module` | Module |
| `method` | Method |
| `call` | CallExpression |
| `assignment` | Assignment |
| `instance_variable` | Variable |
| `constant` | Constant |
| `if` / `unless` / `if_modifier` | IfBlock |
| `while` / `until` | WhileLoop |
| `block` / `do_block` | Block |
| `array` | ArrayLiteral |
| `hash` | ObjectLiteral |
| `string` | string_literal |

## Example

Renaming a method:

```ruby old.rb
class Counter
  def total(n)
    n + 1
  end
end
```

```ruby new.rb
class Counter
  def sum(n)
    n + 1
  end
end
```

Running `differens old.rb new.rb`:

```text
  ~ renamed method `total` to `sum` in class `Counter`
```

## Known limitations

- Dynamic method definition (`define_method`) is a call, not a method: names built at runtime are invisible to the extractor.
- `true`, `false`, and `nil` are anonymous tokens in the grammar. The native parser retains their token text, so changes between them remain visible.
