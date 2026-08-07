# ADR-0007 — Rationals are canonical
Status: Accepted
Date: 2026-08-07
Relates to: M2-05, M2-20, M2-32 · REL-03

## Context

Scoring holds every value as an exact rational — two arbitrary-precision
integers — so no mark is ever decided by binary floating point. The first
implementation left those pairs unreduced: `makeRational` normalised only the
sign of the denominator.

M2-20's save-and-load test then failed on deep equality. Four marks written to
`numeric(14,4)` read back as `"4.0000"` and parse to `40000/10000`; the same
value computed in memory is `4/1`. `compareRational` says they are equal —
cross-multiplication does not care about representation. `toEqual` says they
are not.

That is not a test problem. **M2-32 asserts determinism (REL-03) on
byte-identical canonical serializations across 1,000 runs.** If two equal
values can serialize differently, that check passes on records that differ and
fails on records that do not, and it is measuring nothing either way.

## Decision

`makeRational` reduces by the greatest common divisor and keeps the
denominator positive. A value has exactly one representation, everywhere.

Every construction path goes through it. A raw `{ num, den }` object literal
is a latent invariant violation, and `decimal.spec.ts` now asserts canonicality
across every constructor and operation.

## Consequences

**No hash moved.** `hashMarkingRuleSet` (M1-08) is computed over the marking
rule set, whose marks are plain `number`s, and it imports only `node:crypto`
and curriculum value objects. `Rational` lives in the scoring domain, which
Curriculum cannot reach — `domain/` imports nothing. Verified: `git diff` of
`marking-rule-set-hashes.json` against the M1 close-out commit is empty, and
both shipped profiles still publish under `4fe24605…7a91` and `048dabf4…1ae6`.

**No persisted row carries a pre-canonical value.** Marks persist as decimal
text through `rationalToDecimalString`, which renders the value rather than the
representation, so a row written before this change parses to the same
canonical rational after it. `parseRational('4.0000')` equalling
`parseRational('4')` is asserted directly.

**Three defects were found and fixed while auditing this.** All three built
rationals as object literals, bypassing reduction:

- `compare.ts` `RELATIVE_TOLERANCE` computed its band as a raw literal. The
  arithmetic is multiplication only — the fraction times the magnitude of the
  expected value — so exactness was never at risk and no comparison was ever
  wrong. But a non-canonical band escaped into the comparison, and a value that
  can differ structurally from its equal is exactly what this ADR exists to
  prevent. Now `multiplyRational`.
- `rescoring-dry-run.ts` seeded `largestGain`/`largestLoss` and compared against
  zero with literals. Now `ZERO`.

**The determinism check was verified by planting, not assumed.** Two plants,
because the suite makes two different claims:

| Planted | Caught by | Result |
|---|---|---|
| `FIXED` award shifted by 0.0001 | golden expected-marks assertions | 12 failures across all 4 papers |
| Output made to vary between runs | 1,000-run byte-identity | 2 failures |
| `Math.random` anywhere in the scoring domain | F45 | 1 failure |

A third plant is recorded because it is instructive: reversing outcome order
inside aggregation changed nothing and the determinism check passed. That is
correct — summation is order-independent and there is an explicit
shuffle-invariance test asserting so — but it shows the byte-identity check
proves *stability*, not *correctness*. The golden expected-marks assertions are
what catch a semantic change. Neither claim substitutes for the other.

Makes easy: structural equality on records, which is what the determinism soak
and the repository round-trip both rest on.

Makes hard: nothing measurable. Reduction is one `gcd` per construction on
integers the size of exam marks.

## Alternatives

**Compare with `compareRational` in tests instead.** Rejected: it would make
the round-trip test pass while leaving the determinism soak comparing
serializations that can differ for equal values — the defect would survive in
the one place it matters most.

**Reduce lazily, only before serializing.** Rejected: it leaves two kinds of
`Rational` in the system and makes every consumer decide which it holds.
