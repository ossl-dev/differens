# Tier adapters

| Tier | Formats | Analysis |
| --- | --- | --- |
| T5 | Registered source dialects | CST structure and semantic concepts |
| T4 | JSON/JSONC/JSON5, YAML, TOML, INI, ENV | Typed keys, values, and containers |
| T3 | HTML/XML and related markup | Elements, attributes, and text |
| T2 | Plain text/logs and selected extensionless documents | Word changes and paragraph moves |
| T1 | Markdown, other textual formats, unsupported code | Raw line sequence |
| T0 | Binary extensions or undecodable bytes | Changed bytes or optional plugin |

`classify_file` assigns an initial tier from the path. `is_parseable` checks semantic-parser availability. Code/data/markup parser failure or analysis limits fall directly to raw lines. Numbered tiers describe abstraction levels, not a mandatory parser cascade.

Data parsing is format-directed. Scalar type changes, nested YAML edits, and non-label HTML attribute changes remain visible. Original byte comparisons preserve binary differences that text decoding could erase.

See the [tier reference](/reference/tiers.html) for Rust APIs and [pipeline](/how-it-works/tier-pipeline.html) for fallback details.

## Structured data: change one setting

<CodeGroup>

```yaml before.yaml
database:
    pool:
        max: 10
```

```yaml after.yaml
database:
    pool:
        max: 25
```

</CodeGroup>

```bash
differens before.yaml after.yaml
```

```text
  ~ changed value of leaf `max` from `10` to `25` in object `pool`
```

The four-space nesting is preserved. The output names the containing object and
the changed key; data ranges are synthetic tree ranges, not source offsets.

## Markup: change an attribute

<CodeGroup>

```html before.html
<a href="/old" title="a > b">Docs</a>
```

```html after.html
<a href="/new" title="a > b">Docs</a>
```

</CodeGroup>

```bash
differens before.html after.html
```

```text
  ~ changed file content (`/old` → `/new`)
```

The text and `title` stay the same. The `href` value changes even though it is
not the element's label. The `>` inside a quoted attribute remains part of its
value.

## Prose: edit a word

<CodeGroup>

```text before.txt
Ship the blue widget.
```

```text after.txt
Ship the green widget.
```

</CodeGroup>

```bash
differens before.txt after.txt
```

```text
  ~ changed word (`blue` → `green`)
```

A paragraph that changes can produce word actions. Identical paragraphs can also
move within a document. This handling applies to prose inputs, including `.txt`
and `.log` files.

## Markdown: keep line structure

<CodeGroup>

```markdown before.md
# Release notes

Ship the blue widget.
```

```markdown after.md
# Release notes

Ship the green widget.
```

</CodeGroup>

```bash
differens before.md after.md
```

```text
  ~ changed line (`Ship the blue widget.` → `Ship the green widget.`)
```

The same wording change in Markdown is a line edit. Markdown formatting and code
blocks are not parsed as an embedded programming language.

## Binary: changed bytes of the same length

For binary data, equal lengths do not imply equal contents. You can reproduce a
three-byte comparison with:

```bash
printf '\001\002\003' > before.bin
printf '\001\002\004' > after.bin
differens before.bin after.bin
```

```text
  ~ changed file content (`3 bytes` → `3 bytes`)
```

The default binary description reports lengths. Use JSON to detect the `Update`
action; the length text alone does not explain which byte changed. Format-specific
plugins can provide more detail through the Rust library API.

## Add an adapter

Choose an existing tier when it fits the format. Build a validated tree through
`TreeBuilder` and add routing in `crates/differens-tiers/src/router.rs`; raw/prose
adapters may use the shared sequence engine. Keep parser errors visible as line
fallbacks. See [contributing](/guides/contributing.html#adding-a-tier-adapter) and
the [tiers API](/reference/tiers.html) for the extension points.
