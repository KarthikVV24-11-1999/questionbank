# M2 — Scoring Engine + Golden Set · Task Breakdown
**Milestone:** [ROADMAP.md](../ROADMAP.md) M2 · **Duration:** 4 weeks · **Depends on:** M1
**Deployable:** scoring API accepting a synthetic attempt and returning a score record
**Status:** Approved 2026-08-06. All three opening decisions ratified — see below.

> 35 tasks, each independently testable. Paths follow [ENGINEERING-HANDBOOK.md](../ENGINEERING-HANDBOOK.md) §1–2.

**Scope boundary.** M2 owns `contexts/scoring/`. It *executes* marking rule sets; it does not author,
store or validate them — that is M1, consumed exclusively through `contexts/curriculum/public/`.

**What M2 deliberately does not own:**

| Not in M2 | Owner | Why M2 can proceed without it |
|---|---|---|
| `Attempt`, `Form`, `ResponseEvent` aggregates | M6 | M2 defines its own input contract (M2-02). The ROADMAP's "synthetic attempt" is exactly this. |
| Response projection (ASSESSMENT-ENGINE §4, F49) | M6 | The executor takes *projected* answers. Projection determinism is M6's gate; scoring determinism is M2's. |
| `Item`, `AnswerKey` persistence | M3 | M2 defines the answer-key shape it consumes (M2-03) as a value object, not a stored aggregate. |
| Real `PrincipalResolver`, durable `AuditRecorder` | Identity (D4/D5) | Re-scoring uses the in-memory ports M1 established. Step-up authorization is *policy*, fully implementable now. |

---

## Decisions — ratified 2026-08-06

### DEC-1 · `AggregationSpec` — defined by M2, carried on `ExamProfileVersion`
ASSESSMENT-ENGINE §2.1 names `aggregation : AggregationSpec` inside `MarkingRuleSet` and defines it
nowhere. M1 accepted its absence as [C-1](M1-CLOSEOUT.md#part-3--cross-document-consistency). M2 owns
it. **Ratified shape:**

```
AggregationSpec {
  sectionAggregation : SUM                       // the only v1 mode
  totalAggregation   : SUM_OF_SECTIONS
  bestOf?            : { sectionOrdinal, countScored }   // NEET Section B: 10 of 15
  rounding           : { mode: NONE | HALF_UP, decimalPlaces }
  floorAtZero        : bool                      // false for JEE Main and NEET
}
```

**`bestOf` ships in v1.** NEET UG's Section B presents 15 items and scores the best 10; without it
NEET is scored wrong, and a milestone that regresses EXT-01 is not done. Tie-break is **highest marks
first, ties broken by lowest slot ordinal** — deterministic, and it cannot advantage a candidate
arbitrarily.

**It lives on `ExamProfileVersion`, not `MarkingRuleSet`.** This diverges from §2.1's literal shape,
deliberately. The rule set's hash exists to pin *what a response is worth*; aggregation decides *which
item outcomes survive into a total* — a different question, and one the rule set never asks. Keeping
it off the rule set also means no reissued hashes and no second ADR-0003 event. Should a later exam
need aggregation to vary per rule set, that is a versioned change with its own ADR.

**ADR required** (written at M2-12), stating the divergence from §2.1 and this reasoning plainly.

**Boundary note.** `AggregationSpec` is therefore a Curriculum value object, defined under
`contexts/curriculum/domain/value-objects/` and re-exported as a DTO from `curriculum/public/`.
Scoring consumes it through the barrel only, exactly as it consumes `MarkingRuleSetData`. M2-12 is
the one task that extends M1 code; every other task consumes M1 without touching it.

### DEC-2 · Golden set — real harness now, real corpus later
The milestone's headline acceptance criterion is *"100% match against official keys on all 3 golden
papers"*, and handbook §4 requires every marking-logic commit to state a golden-set result. Neither is
satisfiable until real released JEE Main papers with official NTA answer keys are in the repo.
`apps/api/src/testing/golden/` currently holds only `marking-rule-set-hashes.json` (M1's hash
fixtures). This is **content acquisition, not engineering.**

**Ratified: build the harness and the blocking suite now against synthetic fixtures (M2-29, M2-31);
M2-30 becomes a pure data drop that runs the same suite unchanged.** Every marking commit is gated
from M2-31 onward, and handbook §4 becomes satisfiable.

**Two binding conditions.** A gate that certifies nothing is worse than an absent gate, so what it
does and does not prove must be unmissable:

1. **Synthetic fixtures are never labelled or filed as if they were official.** `synthetic` appears in
   the filename, in the fixture header, and in every test name that runs one. No synthetic fixture
   carries an NTA session identity, paper code, or any provenance field implying an official key.
2. **The milestone DoD carries "golden set validated against real released papers" as
   *failed-blocked*, not passed** — exactly as M1 handled the staging item. The harness documentation
   states in its own header that passing it proves the executor is self-consistent and regression-free,
   and proves nothing whatsoever about agreement with a real answer key.

### DEC-3 · Overrides arrive on `ScoringInput`
ASSESSMENT-ENGINE §2.5 says overrides apply "before rule evaluation, at the form level", but `Form`
is M6. **Ratified:** `ScoringInput.overrides: SlotOverride[]`, supplied by the caller. An override
naming an unknown `slotId` is a `Validation` failure — never a silent no-op, which would be a dropped
or bonus item quietly not applied to a real candidate's score.

### Ratified alongside — `indeterminate` is a recorded outcome
M2-07's condition evaluation is three-valued (`matched | not_matched | indeterminate`), and
`indeterminate` is **first-class and recorded on the `ItemOutcome`**, not an internal state that
vanishes. When a numeric entry is unparseable or a required unit is missing, the record must show that
the slot *fell through to `ALWAYS`* rather than being judged wrong. This is what makes ADR-0003 hold
structurally instead of by convention.

---

## Task Index

| ID | Task | Track | Depends on |
|---|---|---|---|
| M2-01 | Scoring context skeleton & error taxonomy | A · domain | — |
| M2-02 | `ScoringInput` — the synthetic-attempt contract | A · domain | 01 |
| M2-03 | `AnswerKey` value object | A · domain | 01 |
| M2-04 | Numeric normalization | A · domain | 01 |
| M2-05 | Numeric comparison — five modes | A · domain | 04 |
| M2-06 | Units & accepted answer forms | A · domain | 04 |
| M2-07 | Condition evaluation — the eight predicates | A · domain | 03, 05, 06 |
| M2-08 | Award application — the three awards | A · domain | 03 |
| M2-09 | Item-level overrides (§2.5) | A · domain | 02 |
| M2-10 | Rule selection & first-match-wins | A · domain | 07 |
| M2-11 | `ItemOutcome` & rule attribution | A · domain | 08, 10 |
| M2-12 | **`AggregationSpec`** + ADR-0006 (DEC-1) | A · domain | — |
| M2-13 | Sectional & total aggregation | A · domain | 11, 12 |
| M2-14 | `ScoreRecord` aggregate | A · domain | 13 |
| M2-15 | **The executor** — the pure scoring function | A · domain | 09, 14 |
| M2-16 | `rule_schema_version` dispatch (R2 / F48) | A · domain | 15 |
| M2-17 | `RescoringOperation` aggregate & dry-run | A · domain | 14 |
| M2-18 | Scoring schema migration | B · data | — |
| M2-19 | Append-only & single-current triggers | B · data | 18 |
| M2-20 | `ScoreRecord` repository | B · data | 14, 18 |
| M2-21 | `RescoringOperation` repository | B · data | 17, 18 |
| M2-22 | Scoring commands & handlers | C · app | 20 |
| M2-23 | Rescoring commands & handlers | C · app | 21 |
| M2-24 | Scoring queries | C · app | 20, 21 |
| M2-25 | Public barrel & boundary enforcement | C · app | 22–24 |
| M2-26 | Domain events & outbox emission | C · app | 22, 23 |
| M2-27 | OpenAPI contract & generated types | D · api | 25 |
| M2-28 | Scoring controllers | D · api | 27 |
| M2-29 | Golden-set fixture format & loader | E · test | 15 |
| M2-30 | Three JEE Main papers as fixtures *(failed-blocked)* | E · content | 29 |
| M2-31 | Golden-set regression suite (F9) | E · test | 29 |
| M2-32 | Determinism soak — 1,000 runs | E · test | 15 |
| M2-33 | Property-based numeric tolerance tests | E · test | 05 |
| M2-34 | Fitness functions F45, F47, F48 | E · test | 15, 16 |
| M2-35 | **JEE Advanced partial credit — EXT-03 proof** | E · test | 15 |

---

## Track A — Scoring Domain

*Pure logic. No I/O, no framework, no ORM, no clock, no randomness (F45). Every task here is
unit-testable in isolation, and every task here is subject to the 100% branch coverage rule.*

### M2-01 · Scoring context skeleton & error taxonomy
**Objective** The context anatomy and the typed-result surface everything else returns.
**Files** `apps/api/src/contexts/scoring/domain/result.ts`, `domain/scoring-error.ts`
**Acceptance**
- Five-directory anatomy created: `api/`, `application/`, `domain/`, `infrastructure/`, `public/`
- `Result<T, E>` mirrors curriculum's — M2 does **not** import curriculum's `result.ts` (§9 rule 2)
- Error codes drawn from the closed handbook §8 taxonomy; scoring uses `Validation`, `NotFound`, `Conflict`, `PreconditionFailed`, `RuleViolation`
- Zero `throw` anywhere under `domain/`
**Tests** Unit: `ok`/`err` construction and narrowing · every error kind constructs · a spec asserting `domain/` contains no `throw`

### M2-02 · `ScoringInput` — the synthetic-attempt contract
**Objective** The `Attempt` half of §3's pure function, owned by Scoring because `Attempt` is M6 (DEC-3).
**Files** `domain/scoring-input.ts`
**Acceptance**
- `ScoringInput { attemptId, pin: ScoringPin, sections: ScoredSection[], overrides: SlotOverride[] }`
- `ScoringPin { examProfileVersionId, markingRuleSetHash, ruleSchemaVersion, taxonomyVersionId, itemVersionIds[] }` — mirrors `AttemptPin` (DOMAIN-MODEL §6)
- `ScoredSection { ordinal, slots: ScoredSlot[] }`; `ScoredSlot { slotId, ordinal, itemType, itemVersionId, marksAvailable, response?, answerKey }`
- A **projected** response, never an event log — `response?: ResponseSnapshot` where absent means unattempted
- Slot ordinals contiguous within a section; section ordinals contiguous from 1; duplicates rejected
- Construction is total: an invalid input returns `Validation`, never a partially-built object
**Tests** Unit: valid input constructs · missing response reads as unattempted · duplicate slotId rejected · ordinal gap rejected · pin field required individually · immutability

### M2-03 · `AnswerKey` value object
**Objective** What "correct" means per item type, as data.
**Files** `domain/answer-key.ts`
**Acceptance**
- Variants: `SINGLE_CORRECT { optionId }`, `MULTI_CORRECT { correctOptionIds[] }`, `MATCHING { pairs[] }`, `NUMERIC { spec: NumericAnswerSpecData }`
- `NUMERIC` consumes the DTO from `curriculum/public/` — never the domain class
- `MULTI_CORRECT` requires ≥1 correct option; `MATCHING` requires ≥1 pair with unique left members
- An answer key whose variant does not match the slot's `itemType` is rejected at construction
- **Never serialized toward a client** — asserted, per §9 rule 10
**Tests** Unit: each variant constructs · empty correct-option set rejected · duplicate matching left-member rejected · variant/itemType mismatch rejected · a spec asserting no answer-key field appears in any API DTO

### M2-04 · Numeric normalization
**Objective** D-001 rule 1 — normalize learner input **before** comparison, never after.
**Files** `domain/numeric/normalize.ts`
**Acceptance**
- All four flags honoured independently: `trimWhitespace`, `stripThousandsSeparator`, `unicodeMinusToAscii`, `caseInsensitiveUnit`
- Each flag off is a no-op — proven per flag, not just in combination
- Unicode minus `−` (U+2212), en-dash and non-breaking space handled; thousands separators stripped only between digits, never as a decimal point
- Splits value from unit and returns both; a supplied unit is stripped when `unit.required = false` (D-001 rule 3)
- Unparseable input returns `Validation` with a code, not a throw and not a silent zero
- Normalization is idempotent: `normalize(normalize(x)) === normalize(x)`
**Tests** Unit: each flag on and off · Unicode minus · `1,234.5` vs `1.234,5` · unit split with and without `required` · idempotence property · unparseable input returns an error · 100% branch

### M2-05 · Numeric comparison — five modes
**Objective** D-001 rules 2, 4 and 6 on exact decimal arithmetic.
**Files** `domain/numeric/compare.ts`
**Acceptance**
- All five modes: `EXACT`, `ABSOLUTE_TOLERANCE`, `RELATIVE_TOLERANCE`, `SIGNIFICANT_FIGURES`, `RANGE`
- **Comparison is exact-decimal, never IEEE-754 float.** `0.1 + 0.2` may not decide a mark. The authored decimal literal M1-05 preserves is parsed as a decimal, not `Number`
- `ABSOLUTE_TOLERANCE`: `|student − expected| ≤ toleranceValue`, boundary **inclusive**
- `RELATIVE_TOLERANCE`: fraction of `|expected|`; `expected = 0` falls back to absolute comparison rather than dividing by zero
- `SIGNIFICANT_FIGURES`: both values rounded to the stated precision before comparison (rule 4); half-away-from-zero rounding, stated explicitly
- `RANGE`: inclusive of both bounds
- Comparison is total and pure — no clock, no randomness, no I/O
**Tests** Unit: each mode's match and non-match · every boundary tested on **both sides and exactly at** the boundary · `expected = 0` under relative tolerance · significant-figure rounding at `.5` · a float-arithmetic regression case (`0.1+0.2`) · 100% branch

### M2-06 · Units & accepted answer forms
**Objective** Unit equivalence and the three accepted input forms.
**Files** `domain/numeric/unit.ts`, `domain/numeric/answer-form.ts`
**Acceptance**
- Unit compared only when `unit.required = true` (D-001 rule 3); canonical plus `acceptedEquivalents`, case-folded when `caseInsensitiveUnit`
- A missing unit under `unit.required = true` is **indeterminate**, not incorrect — it produces no `EXACT_MATCH` and falls through to the terminal rule (ADR-0003)
- `DECIMAL`, `FRACTION` (`3/4`, `-3/4`), `SCIENTIFIC` (`1.5e3`, `1.5×10^3`) parsed to the same decimal
- A form absent from `acceptedForms` is rejected as input, not silently coerced
- Fraction with zero denominator returns `Validation`
**Tests** Unit: each accepted equivalent matches · case sensitivity both ways · missing required unit is indeterminate and costs nothing · each form parses · disallowed form rejected · zero denominator · 100% branch

### M2-07 · Condition evaluation — the eight predicates
**Objective** ASSESSMENT-ENGINE §2.2, evaluated. The closed set stays closed.
**Files** `domain/conditions/evaluate-condition.ts`
**Acceptance**
- All eight evaluate: `UNATTEMPTED`, `EXACT_MATCH`, `NO_MATCH`, `ALL_CORRECT_SELECTED`, `PARTIAL_CORRECT_SELECTED{minCorrect,noIncorrect}`, `ANY_INCORRECT_SELECTED`, `MATCHING_PAIRS_CORRECT{count}`, `ALWAYS`
- `EXACT_MATCH` dispatches by answer-key variant: option identity for `SINGLE_CORRECT`, M2-05 comparison for `NUMERIC`
- `NO_MATCH` requires a response to exist **and** be recognisably wrong — an indeterminate response matches neither `EXACT_MATCH` nor `NO_MATCH` (ADR-0003)
- `ALWAYS` always matches
- Evaluation returns `matched | not_matched | indeterminate` — three-valued, not boolean. This is what makes ADR-0003 structural rather than incidental
- An unknown condition kind returns `not_matched`, never a throw and never a match
**Tests** Unit: each predicate's positive and negative case · `PARTIAL_CORRECT_SELECTED` at `minCorrect−1`, `minCorrect`, `minCorrect+1`, and with `noIncorrect` both ways · `MATCHING_PAIRS_CORRECT` at exactly *n* and at *n±1* · indeterminate numeric matches neither `EXACT_MATCH` nor `NO_MATCH` · unknown kind is inert · 100% branch

### M2-08 · Award application — the three awards
**Objective** ASSESSMENT-ENGINE §2.3, applied.
**Files** `domain/awards/apply-award.ts`
**Acceptance**
- `FIXED { marks }` awards exactly that, positive or negative
- `PER_CORRECT { marks }` = marks × count of correct selections; zero correct awards 0, never negative-by-multiplication
- `FULL_MARKS` awards the slot's `marksAvailable` regardless of response
- Arithmetic is exact-decimal, consistent with M2-05
- An unknown award kind returns `RuleViolation` and **awards nothing** — fail closed (§8)
**Tests** Unit: each award · `PER_CORRECT` at 0, 1, n · `FULL_MARKS` on an unattempted slot · negative `FIXED` · unknown kind fails closed · 100% branch

### M2-09 · Item-level overrides (§2.5)
**Objective** Overrides applied **before** rule evaluation, per §3's fixed execution order.
**Files** `domain/overrides/apply-overrides.ts`
**Acceptance**
- `DROPPED` — slot excluded from **both** awarded and available marks
- `BONUS` — `FULL_MARKS` to every attempt regardless of response
- `KEY_CORRECTED { replacementKey }` — the new key replaces the slot's, and rules then evaluate normally
- Applied before any rule evaluation; a dropped or bonus slot never reaches the executor's rule loop
- An override naming an unknown `slotId` returns `Validation` — never a silent no-op (DEC-3)
- Two overrides on one slot returns `Conflict`
- A dropped slot's `ItemOutcome` records correctness `dropped`; a bonus slot records `bonus`
**Tests** Unit: each override's effect on awarded and available marks · dropped slot lowers `maxAvailable` · bonus slot pays an unattempted response · `KEY_CORRECTED` changes the outcome of a previously-wrong response · unknown slot rejected · duplicate override rejected · 100% branch

### M2-10 · Rule selection & first-match-wins
**Objective** §3 — "first matching rule wins; evaluation stops there".
**Files** `domain/rule-selection.ts`
**Acceptance**
- A rule applies only when the slot's `itemType` ∈ `appliesTo.itemTypes` **and**, when `sectionOrdinals` is present, the slot's section ordinal ∈ it
- Rules evaluated in authored order; evaluation stops at the first match — later rules are not evaluated, proven by a spy or an evaluation-count assertion
- A rule whose condition returns `indeterminate` does not match and evaluation continues
- **A slot matching no rule is a hard error** (§3), returning `RuleViolation` naming the slot — not a zero. `ALWAYS` must be present, and M1's F46 guarantees it is
- Order is preserved exactly as `MarkingRuleSetData.rules` supplies it — no sorting, ever
**Tests** Unit: first match wins with a later matching rule proven unevaluated · `itemTypes` filter excludes · `sectionOrdinals` filter excludes · absent `sectionOrdinals` matches every section · indeterminate falls through to the terminal rule · a rule set with `ALWAYS` stripped produces a hard error, not a zero · a 7-rule set evaluates in authored order · 100% branch

### M2-11 · `ItemOutcome` & rule attribution
**Objective** DOMAIN-MODEL §7 — every outcome names the rule that produced it (F47).
**Files** `domain/item-outcome.ts`
**Acceptance**
- Carries `slotId`, `itemVersionId`, `responseSnapshot`, `correctness` (`correct`/`incorrect`/`unattempted`/`dropped`/`bonus`/**`indeterminate`**), `marksAwarded`, `ruleApplied { ruleId, explanation }`
- **`indeterminate` is a recorded correctness value, not an internal state.** An unparseable numeric entry or a missing required unit records `indeterminate`, names the terminal rule it fell through to, and explains why — never `incorrect` (ADR-0003, DEC-1 addendum)
- **`ruleApplied.ruleId` is non-optional.** An `ItemOutcome` cannot be constructed without one (F47 enforced by the type, not by a checker)
- `explanation` is human-readable and derived from the condition and award — "unattempted → 0 marks", "correct → +4 marks", "incorrect → −1 mark"
- `responseSnapshot` carries no answer key and no solution (§9 rule 10)
- Immutable once constructed
**Tests** Unit: construction requires a ruleId (compile-time and runtime) · explanation text for each of the eight conditions · dropped and bonus outcomes name the override, not a rule · snapshot excludes key material · immutability

### M2-12 · `AggregationSpec` (DEC-1)
**Objective** Define the type ASSESSMENT-ENGINE §2.1 names and never specifies. **The one task that extends M1 code.**
**Files** `contexts/curriculum/domain/value-objects/aggregation-spec.ts`, `contexts/curriculum/domain/exam-profile-version.ts`, `contexts/curriculum/public/index.ts` · **plus `docs/adr/ADR-0006-aggregation-spec-on-exam-profile-version.md`**
**Acceptance**
- Shape per DEC-1, `bestOf` included
- Carried on `ExamProfileVersion`, **not** on `MarkingRuleSet` — no published rule-set hash changes, asserted by re-running M1's golden hash fixtures unchanged
- Re-exported from `curriculum/public/` as a read-only DTO; Scoring consumes it through the barrel only
- Every field has a default reproducing JEE Main's behaviour with no configuration (`SUM`, `SUM_OF_SECTIONS`, no `bestOf`, `NONE` rounding, `floorAtZero: false`)
- Rounding mode explicit — never left to the language's default
- `bestOf.countScored` ≤ the section's `itemCount`, and `sectionOrdinal` must exist in the profile; violations rejected at construction
- ADR-0006 records the divergence from §2.1's literal shape and the reasoning
**Tests** Unit: default spec reproduces JEE Main · each field validated · `bestOf` overrunning `itemCount` rejected · unknown `sectionOrdinal` rejected · **M1 golden hashes unchanged** · profile publication still succeeds for both shipped profiles · 100% branch

### M2-13 · Sectional & total aggregation
**Objective** §3's third and fourth execution steps.
**Files** `domain/aggregate-scores.ts`
**Acceptance**
- `SectionScore { raw, maxAvailable, attemptedCount, correctCount, incorrectCount, negativeMarksIncurred }` per DOMAIN-MODEL §7
- `TotalScore` is the sum of section scores — never recomputed from outcomes independently, so the two can never disagree
- Dropped slots reduce `maxAvailable`; bonus slots do not
- `negativeMarksIncurred` is the sum of negative awards, reported positive
- Aggregation is order-independent: shuffling `itemOutcomes` yields an identical result
**Tests** Unit: counts per category · dropped slot reduces `maxAvailable` · bonus slot does not · negative marks tallied · total equals the section sum · shuffle-invariance property (100 shuffles) · empty section · 100% branch

### M2-14 · `ScoreRecord` aggregate
**Objective** DOMAIN-MODEL §7 — one interpretation of an attempt (D3).
**Files** `domain/score-record.ts`
**Acceptance**
- Carries `scoreRecordId`, `attemptId`, `markingRuleSetHash`, **`ruleSchemaVersion`**, `generation`, `isCurrent`, `supersedesScoreRecordId?`, `totalScore`, `sectionScores[]`, `itemOutcomes[]`, `computedAt`, `reasonForRescore?`
- **`markingRuleSetHash` and `ruleSchemaVersion` are both mandatory and both pinned from the input** (R2)
- Generation 1 has no `supersedesScoreRecordId`; generation *n* > 1 requires one and a `reasonForRescore`
- Immutable once produced — no mutator exists. Superseding returns a **new** record and leaves the original untouched (INV-11 structural)
- `computedAt` is **supplied**, never read from a clock inside the domain (F45)
**Tests** Unit: construction · generation 1 without a supersedes reference · generation 2 requires one · generation 2 requires a reason · superseding returns a new instance and the original is unchanged · immutability of every field · no `Date.now`/`new Date()` anywhere in `domain/` (asserted by spec)

### M2-15 · The executor — the pure scoring function
**Objective** `(ScoringInput, MarkingRuleSetData, AggregationSpec) → Result<ScoreRecord>`. The milestone.
**Files** `domain/score-attempt.ts`
**Acceptance**
- **Execution order is exactly §3's:** overrides → per-slot rule evaluation → sectional aggregation → total. Proven by an ordering test, not by reading the code
- Pure: no clock, no randomness, no I/O, no module-level mutable state (F45)
- Rejects input whose `markingRuleSetHash` does not match the supplied rule set's hash — scoring under an unpinned rule set is a `PreconditionFailed`
- Every `ItemOutcome` carries a `ruleApplied` (F47)
- A slot matching no rule aborts the whole record with `RuleViolation` — a partial `ScoreRecord` is never returned
- **The terminal `ALWAYS` awards 0** and an unanticipated response state costs the candidate nothing (ADR-0003), asserted directly
- Called twice with the same input, returns deeply-equal records (the 1,000-run soak is M2-32)
**Tests** Unit: JEE Main paper scores correctly end to end · execution order asserted · hash mismatch rejected · no-match aborts wholly · unanticipated state awards 0 · two calls deeply equal · every outcome attributed · 100% branch

### M2-16 · `rule_schema_version` dispatch (R2 / F48)
**Objective** §3 — "the executor must support every historical schema version forever".
**Files** `domain/schema-version-registry.ts`
**Acceptance**
- A registry maps `schemaVersion → executor implementation`; version 1 is M2-15
- An unregistered version returns `PreconditionFailed` naming the version — never a best-effort score
- A registered version can never be removed: a spec enumerates every version ever shipped and asserts each is still registered
- The version used is recorded on the `ScoreRecord`
**Tests** Unit: version 1 dispatches · unknown version rejected · the historical-version enumeration spec fails when a version is deleted (proven by planting a deletion) · 100% branch

### M2-17 · `RescoringOperation` aggregate & dry-run
**Objective** DOMAIN-MODEL §7 — governed, previewable, auditable re-scoring.
**Files** `domain/rescoring-operation.ts`, `domain/rescoring-dry-run.ts`
**Acceptance**
- Carries `operationId`, `trigger`, `scope` (item version / rule change / form), `reason`, `dryRunResult`, `state`, `authorizedBy`, `executedAt?`
- States: `drafted → previewed → approved → executing → completed`. **Every other transition is rejected**, and `approved` is unreachable without a `dryRunResult`
- `reason` is mandatory and non-empty at draft
- `dryRunResult { affectedAttemptCount, scoreDeltaDistribution, rankMovement }`
- **The dry-run runs the same executor as execution** — not a parallel implementation. Preview and execution are provably identical (proven in M2-23 against the database)
- Execution never mutates a prior `ScoreRecord`; it produces generation *n+1* and flips `isCurrent`
**Tests** Unit: legal transitions · every illegal transition rejected · approve without a dry-run rejected · empty reason rejected · dry-run and execution produce identical outcomes for the same scope · prior generation survives

---

## Track B — Data

### M2-18 · Scoring schema migration
**Objective** The `scoring` schema.
**Files** `infra/migrations/<timestamp>_scoring_schema.sql`, `contexts/scoring/infrastructure/schema.ts`
**Acceptance**
- Tables (snake_case, singular): `score_record`, `item_outcome`, `section_score`, `rescoring_operation`
- **No cross-schema foreign key** to `curriculum` (§9 rule 3) — `exam_profile_version_id` and `marking_rule_set_hash` are carried as values, not references
- Every JSONB column has a sibling `*_schema_version` (§9 rule 5 / F5) — `item_outcome.response_snapshot`, `rescoring_operation.dry_run_result`
- `tenant_id`, `aggregate_version`, `created_at` per the M1 convention (P7, P8, P1)
- Partial unique index enforcing **exactly one `is_current = true` per attempt** (DOMAIN-MODEL §7)
- Migration runs up, down, and up again on a clean database
**Tests** Integration (real Postgres): up/down/up · catalogue query proving every JSONB column has a version sibling · the partial unique index rejects a second current record · no FK crosses schemas

### M2-19 · Append-only & single-current triggers
**Objective** INV-11 at the database, not in application code.
**Files** `infra/migrations/<timestamp>_scoring_immutability.sql`
**Acceptance**
- `score_record`, `item_outcome`, `section_score` reject `UPDATE` and `DELETE` by trigger — **except** the single `is_current` flip, which is the only permitted update and is permitted only to `false`
- No `UPDATE`/`DELETE` grant for the app role on append-only tables (§9 rule 11)
- Proven from raw `psql`, not only through the ORM — the M1 close-out standard
- Superseding flips the old record's `is_current` and inserts the new; both rows survive
**Tests** Integration: raw SQL `UPDATE` rejected on each table · raw SQL `DELETE` rejected · `is_current` false-flip permitted · flip back to `true` rejected · both generations retained

### M2-20 · `ScoreRecord` repository
**Objective** Persistence with the casing boundary in exactly one place (§2).
**Files** `infrastructure/score-record.repository.ts`
**Acceptance**
- Save is transactional across `score_record`, `section_score`, `item_outcome` — one aggregate, one transaction (§10)
- Load reconstitutes an identical aggregate: save → load → deep-equal, including exact decimal marks
- `findCurrentByAttemptId`, `findAllGenerationsByAttemptId` (ordered by generation)
- Decimal marks survive the round trip as decimals — **not** as floats
- snake_case ↔ camelCase mapping happens here and nowhere else
**Tests** Integration: save/load deep equality · decimal precision preserved (`0.1`, `-1`, `4`) · generations ordered · concurrent save of a second current record rejected by the index

### M2-21 · `RescoringOperation` repository
**Objective** Persist the operation and its dry-run.
**Files** `infrastructure/rescoring-operation.repository.ts`
**Acceptance**
- Save/load round trip including `dryRunResult` JSONB with its schema version
- State transitions persisted; a stale-version update is rejected (optimistic concurrency on `aggregate_version`)
- Query by state, for the operator console
**Tests** Integration: round trip · concurrency conflict surfaces as `Conflict`, never a silent overwrite · query by state

---

## Track C — Application

### M2-22 · Scoring commands & handlers
**Objective** Orchestration only. No business logic (§1).
**Files** `application/commands/scoring-commands.ts`, `application/handlers/scoring-handlers.ts`
**Acceptance**
- `ScoreAttempt { attemptId, input, idempotencyKey }` produces generation 1
- **Every handler declares an authorization policy — boot fails otherwise** (§9 rule 6 / F36)
- Idempotent on `idempotencyKey`: a repeat returns the existing record, never a second generation
- `computedAt` is injected by the handler from a clock port, keeping the domain clock-free (F45)
- Handler returns a typed Result; infrastructure faults are the only throws
**Tests** Unit + integration: happy path · idempotent repeat · authorization negative path (100% required by §5) · a policy-less handler fails module boot · clock injected, not read

### M2-23 · Rescoring commands & handlers
**Objective** The consequential command — dry-run mandatory, step-up authorized.
**Files** `application/commands/rescoring-commands.ts`, `application/handlers/rescoring-handlers.ts`
**Acceptance**
- `DraftRescoring`, `RunRescoringDryRun`, `ApproveRescoring`, `ExecuteRescoring`
- **Execution without a prior dry-run is rejected** at the handler as well as in the domain
- Step-up authorization required to approve; the negative path is tested (D5's in-memory `PrincipalResolver` is sufficient — the policy is real even if the resolver is not)
- Every operation writes an audit record through the `AuditRecorder` port (D4)
- **Dry-run preview matches execution exactly** — asserted against real Postgres over a multi-attempt scope, per the milestone acceptance criterion
- Prior generations retained; exactly one current record per attempt afterwards
**Tests** Integration (real Postgres): dry-run then execute produce identical deltas · execute without dry-run rejected · unauthorized approval rejected · audit written · both generations survive · one current record

### M2-24 · Scoring queries
**Objective** Read models. **No answer keys, no solutions** (§9 rule 10).
**Files** `application/queries/scoring-queries.ts`
**Acceptance**
- `GetScoreRecord`, `ListScoreRecordGenerations`, `GetRescoringDryRun`
- Every view carries the per-item rule attribution and explanation — the score is explainable item by item (FR-MOCK-07)
- **No view exposes an answer key, a correct option, or a solution**, asserted per view
- Each query declares an authorization policy; a learner reads only their own records
**Tests** Unit + integration: each query · answer-key absence asserted per view · cross-learner read rejected · non-existent record returns `NotFound`

### M2-25 · Public barrel & boundary enforcement
**Objective** §9 rule 1, held to M1's standard.
**Files** `public/index.ts`
**Acceptance**
- Exports exactly commands, queries and events — no aggregate, repository or infrastructure type
- Value objects consumers need are re-exported as read-only DTO shapes
- Scoring imports curriculum **only** through `curriculum/public/`, asserted by the boundary checker
- `domain/` imports nothing (F2), including nothing from curriculum
**Tests** `boundary-rules.spec.ts` extended: planted violation reaching into `curriculum/domain` is caught · planted `domain/` import is caught · all four import forms (static, dynamic, `require`, side-effect) covered per ADR-0002

### M2-26 · Domain events & outbox emission
**Objective** Cross-context effects are events, never calls (§9 rule 4).
**Files** `domain/events/scoring-events.ts`, `infrastructure/outbox-emitter.ts`
**Acceptance**
- `AttemptScored`, `AttemptsRescored` — past tense (§2)
- Emitted to `platform.outbox_message` **in the same transaction** as the aggregate write
- Every event has an analytics counterpart or a recorded exemption (F18)
- Payloads carry no answer key and no PII (§9 rules 10, 12)
**Tests** Integration: event row written in the same transaction · rollback leaves no event · F18 reconciliation · payload inspection for key material and PII

---

## Track D — API

### M2-27 · OpenAPI contract & generated types
**Objective** Contract first; no hand-written client (§9 rule 15).
**Files** `apps/api/src/contracts/scoring.openapi.yaml`, `packages/contracts/`
**Acceptance**
- Every endpoint present with an `x-handler` reconciling against the registry (F15, the M1 pattern)
- RFC 9457 Problem Details on every error, with a stable `code` and an explicit `retryable` flag (§8)
- Zod schemas generated, not written
- **No response schema contains an answer key or a solution**, asserted against the document itself
**Tests** Contract: spec/registry reconciliation · every error shape is Problem Details · `retryable` present on every error · answer-key absence asserted over the whole document

### M2-28 · Scoring controllers
**Objective** Controllers and DTOs. No business logic (§1).
**Files** `api/scoring.controller.ts`, `api/dto/scoring-schemas.ts`, `api/scoring.module.ts`
**Acceptance**
- `POST /v1/score-records`, `GET /v1/score-records/{id}`, `GET /v1/attempts/{id}/score-records`, and the four rescoring routes
- Paths plural and kebab-case; JSON fields camelCase (§2)
- Input validated at the boundary; validation failures return `Validation` Problem Details
- Module boot fails if any handler lacks a policy (F36)
- Correlation ID on every response, error or not (§8)
**Tests** Integration: each route happy path · each error path returns Problem Details · malformed body rejected at the boundary · policy-less handler fails boot · correlation ID present

---

## Track E — Golden Set & Correctness Gates

### M2-29 · Golden-set fixture format & loader
**Objective** The harness. It must be real before the corpus is.
**Files** `apps/api/src/testing/golden/format.ts`, `testing/golden/load-golden-paper.ts`
**Acceptance**
- A golden paper is data: profile reference, section and slot definitions, answer keys, a candidate response set, and the **expected total, sectional and per-item marks**
- Expected marks are the *official key's* verdict, recorded independently of the executor — a fixture is never generated by the code it tests
- The loader validates a fixture and fails loudly on a malformed one
- Adding a paper requires no code change
- **Every fixture declares `provenance: 'synthetic' | 'official'`.** A synthetic fixture must carry `synthetic` in its filename and header, and the loader rejects one that claims official provenance without a source citation (DEC-2 condition 1)
- **The harness README states in its own header what the gate proves and does not prove**: passing it shows the executor is self-consistent and regression-free, and shows nothing about agreement with a real answer key (DEC-2 condition 2)
**Tests** Unit: a valid fixture loads · a malformed fixture fails with a named reason · a fixture whose expected marks are self-inconsistent is rejected · a synthetic fixture without `synthetic` in its filename is rejected · an `official` fixture without a source citation is rejected

### M2-30 · Three JEE Main papers as fixtures — **failed-blocked, data drop (DEC-2)**
**Objective** The milestone's headline acceptance criterion.
**Files** `apps/api/src/testing/golden/papers/*.json`
**Acceptance**
- Three released JEE Main papers with official NTA answer keys, as data only
- Each carries provenance: paper identity, session, date, and the source of the official key
- **100% match against the official key on all three**
- Licensing status recorded — released papers are third-party content
**Tests** Golden regression over all three (M2-31). **Cannot be written until the papers are supplied.**

### M2-31 · Golden-set regression suite (F9)
**Objective** Blocking on every commit (§5).
**Files** `apps/api/src/testing/golden/golden-regression.spec.ts`
**Acceptance**
- Runs every fixture in `papers/` and asserts total, sectional and per-item marks
- A single mismatched item fails the build, naming paper, slot, expected and actual
- Runs in the default `pnpm test` — not behind a flag, not a separate command
- Passes on synthetic fixtures now and on the real papers unchanged when M2-30 lands (DEC-2)
- **Every synthetic fixture's test name says so** — `scores synthetic-jee-main-shape paper A to the expected key`, never a name that reads as official (DEC-2 condition 1)
- The suite reports how many official and how many synthetic fixtures it ran, so a run with zero official papers cannot be mistaken for a validated one
**Tests** The suite itself, plus a planted-regression test: a deliberately altered mark value makes it fail · the official/synthetic count is asserted in the summary output

### M2-32 · Determinism soak — 1,000 runs
**Objective** REL-03, the milestone's second acceptance criterion.
**Files** `apps/api/src/contexts/scoring/domain/determinism.spec.ts`
**Acceptance**
- The same input scored 1,000 times produces **byte-identical** records — compared by canonical serialization, not deep-equal
- Slot and section iteration order shuffled between runs without changing the result
- Runs within the per-commit test budget; if it cannot, the count is justified in the spec rather than quietly reduced
**Tests** 1,000-run byte-identity · shuffled-input invariance · a planted `Math.random` in the executor makes it fail

### M2-33 · Property-based numeric tolerance tests
**Objective** §5 — property-based tolerance testing, named in the milestone.
**Files** `apps/api/src/contexts/scoring/domain/numeric/numeric.property.spec.ts`
**Acceptance**
- Properties over generated decimals: normalization is idempotent · a value inside the tolerance band always matches and one outside never does · `RANGE` matches exactly on `[min, max]` · significant-figure comparison is symmetric
- Generators include the adversarial cases: values at the boundary, `expected = 0`, very large and very small magnitudes, trailing zeros, negative zero
- A counterexample is reported with the seed so it is reproducible
**Tests** Each property, minimum 1,000 cases · a planted off-by-one in the tolerance comparison is caught

### M2-34 · Fitness functions F45, F47, F48
**Objective** The gates this milestone adds, each proven with a planted violation (the M1 standard).
**Files** `apps/api/src/fitness/scoring-rules.ts`, `scoring-rules.spec.ts`, `apps/api/vitest.config.ts`
**Acceptance**
- **F45** — the scoring function performs no I/O and reads no clock: no `Date`, `Math.random`, `fs`, `process.env` or network reachable from `score-attempt.ts`, transitively
- **F47** — every `ItemOutcome` carries a `rule_applied_id`, checked in the type and at the database
- **F48** — every historical `rule_schema_version` is registered (M2-16)
- Each fails against a planted violation, committed as a fixture under `src/fitness-fixtures/`
- **Coverage config extended: 100% branch, line, function and statement on every scoring domain module**, and the gate verified failing before it passes
**Tests** Each fitness check green on the real tree and red on its planted fixture · coverage thresholds asserted present for every scoring module

### M2-35 · JEE Advanced partial credit — EXT-03 proof
**Objective** *"A JEE Advanced partial-credit rule set scores correctly with zero code change."*
**Files** `apps/api/src/testing/golden/papers/jee-advanced-multi-correct.json`
**Acceptance**
- The seven-rule set from ASSESSMENT-ENGINE §2.4 scores a multi-correct paper correctly
- Every graded band exercised: all-correct → +4, three-correct → +3, two → +2, one → +1, any-incorrect → −2, unattempted → 0
- **Zero non-data files change** in the commit that adds it — CI-asserted, the M1-30 pattern
- `PER_CORRECT` exercised by at least one rule set, even though JEE Main does not use it
**Tests** Each band asserted · `git diff` over the commit range returns only data files · `PER_CORRECT` scored correctly

---

## Sequencing

```
Week 1   A01→A06 (input, keys, numeric)     ║  B18, B19 (schema + triggers)  ║ DEC-1 ADR
Week 2   A07→A11 (conditions, awards, outcomes) ║ B20, B21 (repos)           ║ E29 (harness)
Week 3   A12→A17 (aggregation, executor, rescoring) ║ C22→C26 (application)  ║ E31→E33 (gates)
Week 4   D27, D28 (API)                     ║  E30 (papers), E34, E35        ║ hardening
```

**Critical path:** A01 → A02 → A07 → A10 → A11 → A15 → C22 → D28 (~16 days)
**Blocked:** M2-30 only, on the real papers being supplied. It is a data drop against a suite that already runs
**E29 should start week 2**, not week 4: the golden harness gates every marking commit from M2-31 onward, and handbook §4 requires a golden-set result in those commit bodies

---

## Milestone Definition of Done

A task is done when merged with tests green. **The milestone** is done when all of the following hold:

- [ ] All 35 tasks merged
- [ ] **Golden set validated against 3 real released papers with official keys** — **expected `Fail — blocked`** until the papers are supplied (DEC-2). Reported as failed-blocked, never as passed, exactly as M1 reported staging
- [ ] Golden-set regression suite blocking in the default test run (F9), with the official/synthetic fixture count reported
- [ ] Identical inputs produce byte-identical score records across 1,000 runs
- [ ] Every item outcome names the rule that produced it
- [ ] An indeterminate response is recorded as `indeterminate` and awards 0 — never `incorrect`
- [ ] Re-scoring retains both generations; dry-run preview matches execution exactly
- [ ] A JEE Advanced partial-credit rule set scores correctly with zero non-data file changes
- [ ] NEET UG's `bestOf` section aggregates correctly — EXT-01 not regressed
- [ ] All five `NumericAnswerSpec` comparison modes evaluated, with units and normalization
- [ ] Fitness functions F45, F47, F48 green, each proven against a planted violation
- [ ] F1, F2, F5, F15, F18, F36, F46 still green
- [ ] **100% branch coverage on every scoring and marking module**; ≥80% line / ≥70% branch overall
- [ ] `AggregationSpec` defined and ratified in ADR-0006; **M1 golden rule-set hashes unchanged**
- [ ] Published score records reject mutation via ORM **and** raw SQL
- [ ] Scoring API serves a synthetic attempt end to end

---
