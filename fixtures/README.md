# Behavior contracts

`parity/` is a frozen oracle captured from revision
`66f292a15bd494d30ff2311ecc02868262dae870` before implementation. It contains
160 seeded tree comparisons, 112 pipeline/presentation cases across all current
language dialects and tiers, and six exact UTF-16 hash vectors. Rust tests consume
these files without JavaScript. Never regenerate expected outputs from the code
being tested.

Action parity excludes cached hash/height metadata; separate vectors verify the
legacy hash algorithm. Every other action field and action ordering is compared.
Grammar revisions and generated source checksums are recorded separately in
`grammar-manifest.json`. Empty/new/deleted files are distinct from read failures.

`corrections/cases.json` records four legacy missed-change bugs. Those cases must
produce changes in Rust even though the frozen JavaScript implementation missed
them. Format-specific parsing can introduce further deliberate corrections;
record them with inputs and rationale rather than weakening corpus comparisons.

The initial oracle is a regression floor, not a claim that all possible behavior
is covered. Crate tests additionally exercise matching invariants, adversarial
hash collisions, topology, deep trees, raw bytes, real Git repositories, parser
budgets, sequence optimality, and streaming order.
