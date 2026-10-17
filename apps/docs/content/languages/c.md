# C

The C extractor reads function and variable names through the declarator chain,
following nested pointer and parenthesized declarators to the identifier. This
keeps parameter lists and pointer syntax out of declaration names.

## Detected concepts

| tree-sitter node type | Canonical concept |
|---|---|
| `function_definition` | Function |
| `declaration` / `init_declarator` | Variable |
| `field_declaration` | Variable |
| `struct_specifier` | Struct |
| `enum_specifier` | Enum |
| `parameter_declaration` | Parameter |
| `preproc_include` | PreprocInclude |
| `return_statement` | Return |
| `if_statement` | IfBlock |
| `number_literal` | number_literal |

## Example

Renaming a function:

```c old.c
int total(int a, int b) { return a + b; }
```

```c new.c
int sum(int a, int b) { return a + b; }
```

Running `differens old.c new.c`:

```text
  ~ renamed function `total` to `sum`
  ~ changed function `sum` (`total` → `sum`)
```

## Example: change the body

Keep the declaration name and change what it does:

<CodeGroup>

```c body-before.c
int total(int n) { return n + 1; }
```

```c body-after.c
int total(int n) { return n + 2; }
```

</CodeGroup>

```bash
differens body-before.c body-after.c
```

```text
  ~ changed function `total` (`1` → `2`)
```

The report groups the value edit under its containing declaration. Use
`--format=json` to inspect the underlying action and context, or `--format=llm`
for a compact report with source locations.

## Known limitations

- Preprocessor macros are tokens, not structure: a macro that generates code does not expand before diffing.
- Prototypes and definitions are matched structurally. Cross-file prototype moves depend on a supported grammar, candidate kind, and matching evidence; header extensions do not currently have a linked grammar.
