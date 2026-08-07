# ADR-0006 — `AggregationSpec` lives on `ExamProfileVersion`, not `MarkingRuleSet`
Status: Accepted
Date: 2026-08-06
Relates to: [tasks/M2-SCORING-ENGINE.md](../tasks/M2-SCORING-ENGINE.md) DEC-1, [tasks/M1-CLOSEOUT.md](../tasks/M1-CLOSEOUT.md) C-1

## Context

ASSESSMENT-ENGINE §2.1 writes the marking rule set as:

```
MarkingRuleSet {
  schema_version : int
  rules          : [MarkingRule]
  aggregation    : AggregationSpec
}
```

`AggregationSpec` is named there once and defined nowhere else in the document
set. M1 shipped `MarkingRuleSet` without it and recorded the divergence as
[C-1](../tasks/M1-CLOSEOUT.md#part-3--cross-document-consistency), on the
grounds that M2 owns aggregation. M2 now has to define it, and defining it
raises two questions the document does not answer: what it contains, and where
it lives.

Two facts force the second question.

**The rule-set hash is pinned into every `ScoreRecord`.** `hashMarkingRuleSet`
is computed over a canonical serialization at publication and frozen into
`marking_rule_set_hash`. Adding a field to `MarkingRuleSet` changes that hash
for every published profile — exactly the event [ADR-0003](ADR-0003-terminal-marking-rule-awards-zero.md)
was, where a scoring-semantics change had to be visible as a hash change and
reviewed as one.

**NEET UG cannot be scored without best-of-N.** Section B presents 15 items and
scores the best 10. A milestone that ships without it regresses EXT-01, which
M1-30 proved.

## Decision

`AggregationSpec` is defined by M2 and **carried on `ExamProfileVersion`,
alongside the marking rule set rather than inside it.**

```
AggregationSpec {
  sectionAggregation : SUM                                 // the only v1 mode
  totalAggregation   : SUM_OF_SECTIONS
  bestOf?            : [{ sectionOrdinal, countScored }]   // NEET Section B: 10 of 15
  rounding           : { mode: NONE | HALF_UP, decimalPlaces }
  floorAtZero        : bool                                // false for JEE Main and NEET
}
```

`bestOf` ships in v1. Ties are broken by **highest marks first, then lowest slot
ordinal** — deterministic, and unable to advantage one candidate over another
arbitrarily.

**This diverges from §2.1's literal shape, deliberately.** The rule set's hash
exists to pin what a *response* is worth. Aggregation decides which item
outcomes survive into a *total* — a different question, and one no marking rule
asks. A rule reads one slot and returns one award; it has no view of the section
and no opinion about which of its siblings count. Placing aggregation inside the
structure whose hash certifies per-response marking would make the hash certify
two unrelated things at once.

Defaults reproduce JEE Main with no configuration: `SUM`, `SUM_OF_SECTIONS`, no
`bestOf`, `NONE` rounding, `floorAtZero: false`.

## Consequences

**No published rule-set hash changes.** M1's golden hash fixtures are asserted
unchanged by this commit. There is no second ADR-0003 event, no reissued
`marking_rule_set_hash`, and no re-review of every published profile.

`AggregationSpec` is therefore a **Curriculum** value object, re-exported from
`contexts/curriculum/public/` as a read-only DTO. Scoring consumes it through
the barrel exactly as it consumes `MarkingRuleSetData`, and never reaches past it.

**Rounding is explicit.** `mode` and `decimalPlaces` are always present rather
than inherited from whatever the language does by default. A total that rounds
differently between two runs is a total nobody can defend.

Makes easy: adding aggregation without touching a single published hash;
scoring NEET correctly; changing an exam's aggregation without re-reviewing its
marking rules.

Makes hard: an exam needing aggregation to *vary per rule set within one
profile*. Nothing in JEE or NEET does. If one arrives it is a versioned change
with its own ADR — and moving the field then is a deliberate, reviewed act
rather than something inherited by default today.

## Alternatives

**Follow §2.1 literally and put it on `MarkingRuleSet`.** Rejected. It reissues
every published rule-set hash to record a fact about totals rather than about
marking, and every reviewer of that change would have to satisfy themselves that
no per-response semantics moved. The cost is real and recurring; the benefit is
conformance to one line of a draft document.

**Omit `bestOf` from v1 and add it later.** Rejected: NEET UG is scored wrong
without it, and a milestone that regresses a proven extension point is not done.

**Leave `AggregationSpec` undefined and hard-code summation.** Rejected. It is
the same choice M1 made, and it defers the decision onto the milestone that can
least afford an undefined total.
