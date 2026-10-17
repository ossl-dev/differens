# Go

The Go extractor maps tree-sitter Go CST nodes to canonical concepts. It detects structural changes at the package level: functions, methods, types, and interfaces.

## Detected concepts

| tree-sitter node type | Canonical concept |
|---|---|
| `function_declaration` | Function |
| `method_declaration` | Method |
| `type_declaration` | TypeDecl |
| `struct_type` | Struct |
| `interface_type` | Interface |
| `import_declaration` | Import |
| `var_declaration` (top-level) | Variable |
| `const_declaration` | Constant |
| `type_alias` | type_alias (unmapped) |

## Example

Two versions of a Go package. The second version moves the method body into a new helper function:

```go old.go
package users

import (
    "errors"
    "strings"
)

type Store struct{}

func (s *Store) ValidateEmail(email string) error {
    if !strings.Contains(email, "@") {
        return errors.New("invalid email")
    }
    if len(email) > 254 {
        return errors.New("email too long")
    }
    return nil
}
```

```go new.go
package users

import (
    "errors"
    "strings"
)

type Store struct{}

func (s *Store) ValidateEmail(email string) error {
    return validateEmail(email)
}

func validateEmail(email string) error {
    if !strings.Contains(email, "@") {
        return errors.New("invalid email")
    }
    if len(email) > 254 {
        return errors.New("email too long")
    }
    return nil
}
```

Running `differens old.go new.go`:

```text
  + added function `validateEmail`
  ~ modified method `Store.ValidateEmail` (`len` → `validateEmail`, 1 removal, 1 addition)
```

Methods include their receiver type in human and LLM output, such as
`Store.ValidateEmail`. Matching uses receiver identity to keep same-named methods
on different types apart, including when a helper takes over an existing body.
This example reports the new helper and the method edit; it does not classify
an extraction as a separate action.

## Known limitations

- Implicit interfaces (structural typing) are not tracked. An interface implemented by coincidence is not flagged as a relationship.
- Package and import changes are syntax edits. The correlator detects supported declaration moves across files; it does not resolve package relationships.
- Cgo blocks are treated as opaque; the extractor does not descend into C preambles.
- Generic type parameters (Go 1.18+) are parsed structurally but type parameter renames may not be detected as renames (reported as structural changes).
