# M2 — Acceptance Criteria → Test Traceability

Every acceptance criterion in [M2-SCORING-ENGINE.md](M2-SCORING-ENGINE.md),
mapped to the test that proves it. Built by re-reading each criterion against
the named test, not by trusting a filename.

**Legend:** ✅ proven · ⚠️ partially proven, gap named · ❌ no test, or a test
that does not assert the criterion.

**Totals: 178 criteria · 173 ✅ · 4 ⚠️ · 1 ❌.**

Findings are collected at the foot of this document.

---

## Track A — Scoring Domain

### M2-01 · Context skeleton & error taxonomy
| Criterion | Test | |
|---|---|---|
| Five-directory anatomy | `context-anatomy.spec.ts` › has a `<dir>/` directory ×5, and no sixth | ✅ |
| `Result` mirrors curriculum's without importing it | `result.spec.ts` › structurally compatible across the barrel | ✅ |
| Errors drawn from the closed §8 taxonomy | `scoring-error.spec.ts` › is the closed set of ten; restricts to five | ✅ |
| Zero `throw` under `domain/` | `scoring-error.spec.ts` › contains no throw — planted throw verified | ✅ |

### M2-02 · `ScoringInput`
| Criterion | Test | |
|---|---|---|
| Shape: attemptId, pin, sections, overrides | `scoring-input.spec.ts` › constructs a valid input | ✅ |
| `ScoringPin` mirrors `AttemptPin` | › carries every pin field through; requires each individually | ✅ |
| `ScoredSection` / `ScoredSlot` shapes | › carries the key through; response kinds carried unchanged | ✅ |
| Projected response, absent = unattempted | › reads an absent response as unattempted | ✅ |
| Slot ordinals contiguous in a section | › requires slot ordinals contiguous from 1 within a section | ✅ |
| Section ordinals contiguous from 1 | › gapped, non-starting and duplicate ordinals each rejected | ✅ |
| Duplicates rejected | › rejects a duplicate slotId across sections | ✅ |
| Construction total; `Validation`, never partial | › returns a Validation error, never a partially-built input | ✅ |

### M2-03 · `AnswerKey`
| Criterion | Test | |
|---|---|---|
| Four variants representable | `answer-key.spec.ts` › each variant constructs | ✅ |
| `NUMERIC` consumes the barrel DTO, not the domain class | › the curriculum barrel DTO remains assignable | ✅ |
| `MULTI_CORRECT` needs ≥1 correct option | › rejects an empty correct-option set | ✅ |
| `MATCHING` needs ≥1 pair, unique left members | › rejects a duplicated left member; permits a repeated right | ✅ |
| Variant/itemType mismatch rejected | › rejects a variant that does not match the item type | ✅ |
| Never serialized toward a client | › §9 rule 10 block, over every API dir and OpenAPI doc | ✅ |

### M2-04 · Numeric normalization
| Criterion | Test | |
|---|---|---|
| Four flags honoured independently | `normalize.spec.ts` › the four flags, each on and off | ✅ |
| Each flag off is a no-op | › same block; `1 234` distinguishes the space flag | ✅ |
| Unicode minus, exotic spaces | › folds every dash form; folds every exotic space | ✅ |
| Separators stripped only between digits | › all-or-nothing grouping; `1,5`, `1,2345`, `1,23,456` | ✅ |
| Value/unit split; unit stripped when not required | › separates simple and compound units; `checkUnit` not_required | ✅ |
| Unparseable returns `Validation`, no silent zero | › rejection rather than a silent zero (7 cases) | ✅ |
| Idempotent | › normalizing twice changes nothing (6 samples) | ✅ |

### M2-05 · Numeric comparison
| Criterion | Test | |
|---|---|---|
| All five modes | `compare.spec.ts` › one describe per mode | ✅ |
| Exact-decimal, never IEEE-754 | `decimal.spec.ts` › is exact where binary floating point is not | ✅ |
| `ABSOLUTE_TOLERANCE` inclusive boundary | › matches exactly on the upper/lower boundary; just outside fails | ✅ |
| `RELATIVE_TOLERANCE`, zero falls back to absolute | › falls back to an absolute comparison when expected is zero | ✅ |
| `SIGNIFICANT_FIGURES` rounds both, half-away-from-zero | › rounds both sides (D-001 rule 4); half away from zero | ✅ |
| `RANGE` inclusive both bounds | › matches exactly on the lower/upper bound | ✅ |
| Total and pure | › never throws, whatever it is given; purity block | ✅ |
| Every boundary on both sides and exactly at | › per-mode boundary trios, plus `numeric.property.spec.ts` ×1000 | ✅ |

### M2-06 · Units & accepted forms
| Criterion | Test | |
|---|---|---|
| Unit compared only when required | `unit.spec.ts` › ignores the unit when not required | ✅ |
| Canonical plus equivalents, case-folded per flag | › matches each accepted equivalent; folds case both ways | ✅ |
| Missing required unit is **indeterminate**, not incorrect | › reports an omitted required unit as missing, never a mismatch | ✅ |
| Three forms parse to the same decimal | › scores a decimal, fraction and scientific value identically | ✅ |
| Form absent from `acceptedForms` rejected, not coerced | › rejects an unlisted form rather than coercing it | ✅ |
| Fraction with zero denominator returns `Validation` | › reports a zero denominator rather than a mismatch | ✅ |

### M2-07 · Condition evaluation
| Criterion | Test | |
|---|---|---|
| All eight evaluate | `evaluate-condition.spec.ts` › one describe per condition | ✅ |
| `EXACT_MATCH` dispatches by key variant | › four describes, one per key variant | ✅ |
| `NO_MATCH` needs a response that is recognisably wrong | › does not match unattempted; is indeterminate on unreadable | ✅ |
| `ALWAYS` always matches | › matches unattempted, correct, and unreadable | ✅ |
| Three-valued outcome | › `indeterminate` asserted in 11 distinct cases | ✅ |
| Unknown kind inert, never throws, never matches | › an unknown condition kind is inert | ✅ |
| `PARTIAL_CORRECT_SELECTED` at n−1, n, n+1, both constraints | › four cases in that describe | ✅ |
| `MATCHING_PAIRS_CORRECT` at exactly n and n±1 | › three cases | ✅ |

### M2-08 · Award application
| Criterion | Test | |
|---|---|---|
| `FIXED` awards exactly, positive or negative | `apply-award.spec.ts` › positive, negative, zero, fractional | ✅ |
| `PER_CORRECT` = marks × count; zero correct → 0 | › awards nothing for zero correct, even with negative marks | ✅ |
| `FULL_MARKS` = `marksAvailable` regardless of response | › awards the slot marks to an unattempted slot | ✅ |
| Exact-decimal arithmetic | › multiplies a fractional mark exactly; 80-award sum | ✅ |
| Unknown kind → `RuleViolation`, awards nothing | › fails closed — no mark at all, rather than a guess | ✅ |

### M2-09 · Item-level overrides
| Criterion | Test | |
|---|---|---|
| `DROPPED` excluded from awarded **and** available | `apply-overrides.spec.ts` + `aggregate-scores.spec.ts` › reduces the available marks | ✅ |
| `BONUS` pays `FULL_MARKS` regardless of response | › disposes as a bonus for an unattempted slot and a wrong one | ✅ |
| `KEY_CORRECTED` replaces the key, rules evaluate normally | › scores normally, but against the replacement key | ✅ |
| Applied before evaluation; never reaches the rule loop | › never yields a key, so no rule can contradict the override | ✅ |
| Unknown `slotId` → `Validation` | › rejected at construction (DEC-3) | ✅ |
| Two overrides on one slot rejected | › rejects two overrides on one slot at construction | ✅ |
| Dropped records `dropped`; bonus records `bonus` | `item-outcome.spec.ts` › records correctness as dropped/bonus | ✅ |

### M2-10 · Rule selection
| Criterion | Test | |
|---|---|---|
| `itemTypes` and `sectionOrdinals` both gate | `rule-selection.spec.ts` › `ruleApplies` block, 5 cases | ✅ |
| Authored order; stops at first match, proven by count | › stops at the first match, leaving later rules unevaluated | ✅ |
| Indeterminate falls through | › lands on the terminal rule when the entry cannot be read | ✅ |
| No rule matched → `RuleViolation` naming the slot | › is a hard error, not a zero; names slot, type and section | ✅ |
| Order never sorted | › never reorders the authored rules (reversal test) | ✅ |

### M2-11 · `ItemOutcome`
| Criterion | Test | |
|---|---|---|
| Full field set incl. `indeterminate` correctness | `item-outcome.spec.ts` › declares the six values plus indeterminate | ✅ |
| `ruleApplied.ruleId` non-optional (F47 by type) | › always names the rule; required on every construction path | ✅ |
| `indeterminate` recorded, not internal | › records indeterminate even where the condition read incorrect | ✅ |
| Explanation derived from condition and award | › reads plainly; describes every condition kind | ✅ |
| Snapshot carries no key or solution | › is the learner response, and carries no key material | ✅ |
| Immutable | › freezes the outcome and its attribution | ✅ |

### M2-12 · `AggregationSpec`
| Criterion | Test | |
|---|---|---|
| Shape per DEC-1, `bestOf` included | `aggregation-spec.spec.ts` › accepts a best-of rule | ✅ |
| On `ExamProfileVersion`, not `MarkingRuleSet` | › keeps aggregation off the rule set entirely | ✅ |
| Re-exported from `curriculum/public/` | `aggregate-scores.spec.ts` › barrel type remains assignable | ✅ |
| Defaults reproduce JEE Main | › the default specification reproduces JEE Main | ✅ |
| Rounding mode explicit | › states the rounding mode explicitly rather than inheriting | ✅ |
| `bestOf` bounds validated | › count/ordinal invalid, duplicate section — 5 cases | ✅ |
| M1 golden hashes unchanged | › leaves the golden hashes exactly as M1 froze them | ✅ |
| ADR-0006 records the divergence | [ADR-0006](../adr/ADR-0006-aggregation-spec-on-exam-profile-version.md) exists; **no test asserts an ADR exists** | ⚠️ |

### M2-13 · Aggregation
| Criterion | Test | |
|---|---|---|
| `SectionScore` full field set | `aggregate-scores.spec.ts` › sums, counts, tallies | ✅ |
| Total = sum of sections, never recomputed | › is the sum of the section scores | ✅ |
| Dropped reduces `maxAvailable`; bonus does not | › two dedicated describes | ✅ |
| `negativeMarksIncurred` positive | › reports the deducted marks as a positive magnitude | ✅ |
| Order-independent | › invariant under outcome order (100 shuffles); section order | ✅ |
| `bestOf` selection, tie on lowest ordinal | › breaks a tie on the earlier slot, deterministically (50 runs) | ✅ |
| Discarded slots leave `maxAvailable` | › leaves the discarded slots out of the available marks | ✅ |

### M2-14 · `ScoreRecord`
| Criterion | Test | |
|---|---|---|
| Full field set incl. `ruleSchemaVersion` | `score-attempt.spec.ts` › the score record block | ✅ |
| Hash and schema version mandatory, pinned from input | › pins the rule set hash and schema version (R2) | ✅ |
| Generation 1 has no predecessor; n>1 needs one and a reason | › four cases | ✅ |
| Immutable; superseding returns a new record | › leaves the predecessor intact when it is superseded | ✅ |
| `computedAt` supplied, never a clock | › takes computedAt from the caller; no clock under `domain/` | ✅ |

### M2-15 · The executor
| Criterion | Test | |
|---|---|---|
| Execution order: overrides → rules → sections → total | `score-attempt.spec.ts` › execution order describe (5 cases) | ✅ |
| Pure: no clock, randomness, I/O, module state | › reads no clock and draws no randomness anywhere under `domain/`; F45 with planted violation | ✅ |
| Hash mismatch → `PreconditionFailed` | › refuses to score against a rule set the attempt is not pinned to | ✅ |
| Every outcome carries `ruleApplied` | › attributes every outcome to a rule (F47) | ✅ |
| Unmatched slot aborts the whole record | › aborts the whole record when one slot matches no rule | ✅ |
| Terminal `ALWAYS` awards 0; unanticipated state costs nothing | › ADR-0003 describe, 5 cases | ✅ |
| Two calls deeply equal | › returns deeply equal records on repeated calls | ✅ |

### M2-16 · Schema-version dispatch
| Criterion | Test | |
|---|---|---|
| Registry maps version → executor; v1 is M2-15 | `schema-version-registry.spec.ts` › routes version 1 | ✅ |
| Unregistered → `PreconditionFailed` naming the version | › refuses an unregistered version; names the version | ✅ |
| A registered version can never be removed | › fails when a shipped version loses its executor (planted) | ✅ |
| The version used is recorded on the record | › records the pinned version on the score record | ✅ |

### M2-17 · `RescoringOperation`
| Criterion | Test | |
|---|---|---|
| Full field set | `rescoring-operation.spec.ts` › drafting block | ✅ |
| State machine; every other transition rejected | › refuses every move it does not name (6 cases) | ✅ |
| `approved` unreachable without a dry run | › cannot approve a draft that has not been previewed | ✅ |
| Reason mandatory at draft | › refuses a draft with no reason | ✅ |
| `dryRunResult` shape | › counts, distribution, rank movement, per-attempt deltas | ✅ |
| Dry run uses the same executor as execution | `scoring-handlers.integration.spec.ts` › preview matches execution exactly | ✅ |
| Execution never mutates a prior record | › supersedes without touching the original record | ✅ |

---

## Track B — Data

### M2-18 · Scoring schema
| Criterion | Test | |
|---|---|---|
| Four tables, snake_case singular | `scoring-schema.integration.spec.ts` › creates exactly the four tables; names every table in the singular | ✅ |
| No cross-schema foreign key | › holds for every constraint the scoring schema declares | ✅ |
| Every JSONB column has a version sibling (F5) | › holds across the whole scoring schema, and for `aggregation` | ✅ |
| `tenant_id`, `aggregate_version`, `created_at` | › carries them on each aggregate root | ✅ |
| One current record per attempt | › rejects a second current record for the same attempt | ✅ |
| Up/down/up on a clean database | › leaves no scoring schema behind on down, rebuilds on up | ✅ |

### M2-19 · Append-only triggers
| Criterion | Test | |
|---|---|---|
| Reject UPDATE/DELETE, except the `is_current` flip to false | `scoring-immutability.integration.spec.ts` › 5 + 3 cases | ✅ |
| Proven from raw SQL, not only the ORM | › every assertion runs raw SQL through the pool; psql transcript in M2-CLOSEOUT | ✅ |
| Detail tables admit no update at all | › item outcomes and section scores admit no update | ✅ |
| Superseding retains both generations | › retains both generations after a re-score | ✅ |
| No UPDATE/DELETE grant for the app role (§9 rule 11) | Migration revokes conditionally on the role existing. **The role does not exist locally, so the revoke is never exercised** | ⚠️ |

### M2-20 · `ScoreRecord` repository
| Criterion | Test | |
|---|---|---|
| Save transactional across three tables | `score-record.repository.integration.spec.ts` › writes nothing at all when a detail row is rejected | ✅ |
| Save → load deep-equal, exact decimals | › reconstitutes an identical aggregate | ✅ |
| `findCurrentByAttemptId`, `findAllGenerationsByAttemptId` ordered | › finds the current record; returns generations oldest first | ✅ |
| Decimals survive as decimals, not floats | › preserves a fractional mark exactly; returns BigInt rationals | ✅ |
| Casing mapping here and nowhere else | Row interfaces are local to the repository. **No test asserts the mapping happens nowhere else** | ⚠️ |

### M2-21 · `RescoringOperation` repository
| Criterion | Test | |
|---|---|---|
| Round trip incl. `dryRunResult` JSONB | `rescoring-operation.repository.integration.spec.ts` › round trips the dry-run result | ✅ |
| Optimistic concurrency; stale write rejected | › refuses a write from a stale read rather than overwriting | ✅ |
| Query by state | › returns the operations in a given state | ✅ |

---

## Track C — Application

### M2-22 · Scoring commands & handlers
| Criterion | Test | |
|---|---|---|
| `ScoreAttempt` produces generation 1 | `scoring-handlers.integration.spec.ts` › scores and persists an attempt | ✅ |
| Every handler declares a policy (F36) | › registers every scoring handler with a declared policy; planted policy-less handler | ✅ |
| Idempotent on the attempt | › a repeat returns the existing record, never a second generation | ✅ |
| `computedAt` injected from a clock port | › takes computedAt from the injected clock | ✅ |
| Typed Result; only infrastructure throws | `correctness-bearing.spec.ts` › surfaces a save rejection | ✅ |
| Authorization negative path | › refuses a principal without the role | ✅ |

### M2-23 · Rescoring commands & handlers
| Criterion | Test | |
|---|---|---|
| Four commands | `scoring-handlers.integration.spec.ts` › previews, approves and executes | ✅ |
| Execution without a dry run refused at the handler | › refuses execution before a dry run | ✅ |
| Step-up required to approve; negative path tested | › refuses approval without step-up; refuses ops-only principal | ✅ |
| Every operation audited | › audits every step of the operation | ✅ |
| Dry-run preview matches execution exactly | › every delta the preview promised checked against the stored record | ✅ |
| Prior generations retained; one current record | › retains both generations after execution | ✅ |

### M2-24 · Queries
| Criterion | Test | |
|---|---|---|
| Three queries | `scoring-handlers.integration.spec.ts` + `correctness-bearing.spec.ts` | ✅ |
| Every view carries rule attribution and explanation | › explains every outcome by naming its rule | ✅ |
| No view exposes a key, correct option or solution | › exposes no answer key … (5 field names, serialized scan) | ✅ |
| Each query declares a policy; learner reads only their own | › refuses a learner reading someone else's record | ✅ |

### M2-25 · Barrel & boundary
| Criterion | Test | |
|---|---|---|
| Exports commands, queries, events only | `m3-seam.spec.ts` › value exports are deliberately few | ✅ |
| Value objects as read-only DTOs | › builds a scoring input without reaching past the barrel | ✅ |
| Scoring imports curriculum only via its barrel | `boundary-rules.spec.ts` › permits scoring to consume curriculum through the barrel | ✅ |
| `domain/` imports nothing | › F2 block, generalised to every context, with planted violations | ✅ |

### M2-26 · Events & outbox
| Criterion | Test | |
|---|---|---|
| Two events, past tense | `scoring-handlers.integration.spec.ts` › publishes AttemptScored / AttemptsRescored | ✅ |
| Emitted in the aggregate's transaction | `outbox-emitter.integration.spec.ts` › loses the event when the transaction rolls back | ✅ |
| F18 analytics counterpart | Covered for curriculum; scoring events not yet in the F18 reconciliation | ⚠️ |
| Payloads carry no key or PII | `scoring-contract.spec.ts` › names none of them anywhere | ✅ |

---

## Track D — API

### M2-27 · OpenAPI contract
| Criterion | Test | |
|---|---|---|
| `x-handler` on every operation, reconciled (F15) | `scoring-contract.spec.ts` › names a handler on every operation | ✅ |
| RFC 9457 with stable `code` and explicit `retryable` | › sets retryable explicitly for every error kind | ✅ |
| Zod schemas generated, not written | Schemas are hand-written and kept in step by the contract spec. **The criterion says generated; they are not** | ⚠️ |
| No response schema contains a key or solution | › names none of them anywhere in the document | ✅ |

### M2-28 · Controllers
| Criterion | Test | |
|---|---|---|
| Eight routes | `scoring.controller.integration.spec.ts` › routes describe | ✅ |
| Paths plural kebab-case; JSON camelCase | `scoring-contract.spec.ts` › uses plural kebab-case paths | ✅ |
| Input validated at the boundary | › rejects a malformed body, unknown field, blank reason, bad param | ✅ |
| Module boot fails without a policy (F36) | › refuses to register a policy-less handler | ✅ |
| Correlation ID on every response | › echoes the one it was given; mints one on error as well | ✅ |

---

## Track E — Golden set & gates

### M2-29 · Fixture format & loader
| Criterion | Test | |
|---|---|---|
| Paper is data: profile, slots, keys, responses, expected marks | `golden-regression.spec.ts` › per-paper describes | ✅ |
| Expected marks recorded independently of the executor | Fixtures are authored, not generated. **Enforced by convention and review, not by a test** | ⚠️ |
| Loader validates and fails loudly | › the loader refuses a fixture it cannot trust (9 cases) | ✅ |
| Adding a paper needs no code change | › `describe.each(papers)` over the directory | ✅ |
| Provenance enforced; synthetic labelled | › rejects a synthetic fixture not labelled as one; official without a source | ✅ |
| README states what the gate proves and does not | `testing/golden/README.md` | ✅ |

### M2-30 · Three real papers
| Criterion | Test | |
|---|---|---|
| Three released JEE Main papers with official keys | **None exist** | ❌ blocked — see M2-CLOSEOUT Part 4 |
| 100% match against the official key | Cannot run | ❌ blocked |

*(Counted once as the single ❌ in the totals; the gate is carried, not silently dropped.)*

### M2-31 · Regression suite
| Criterion | Test | |
|---|---|---|
| Runs every fixture; total, sectional, per-item | `golden-regression.spec.ts` › four assertions per paper | ✅ |
| A mismatch fails the build, naming the paper and slot | › assertion labels carry paperId and slotId | ✅ |
| Runs in the default `pnpm test` | Included in the unit project; no flag | ✅ |
| Reports official/synthetic counts | › reports what it ran | ✅ |
| Planted regression fails it | › catches a single altered mark; verified live in M2-CLOSEOUT Part 3 | ✅ |

### M2-32 · Determinism soak
| Criterion | Test | |
|---|---|---|
| 1,000 runs byte-identical on canonical serialization | `golden-regression.spec.ts` › produces byte-identical records | ✅ |
| Shuffled input invariance | › does not depend on the order slots arrive in | ✅ |
| A planted `Math.random` makes it fail | Verified live: output-varying plant → 2 failures; F45 → 1 failure | ✅ |

### M2-33 · Property tests
| Criterion | Test | |
|---|---|---|
| Idempotence, band inclusion, RANGE, symmetry | `numeric.property.spec.ts` › four describes, 1000 cases each | ✅ |
| Adversarial generators | › adversarial values (7 named cases) | ✅ |
| Counterexample reproducible with the seed | Seeded xorshift; seed in every assertion label | ✅ |
| A planted off-by-one is caught | › an exclusive boundary would fail the band property | ✅ |

### M2-34 · Fitness functions
| Criterion | Test | |
|---|---|---|
| F45 no I/O or clock, transitively | `scoring-rules.spec.ts` › clean across the whole scoring domain | ✅ |
| F47 in the type and at the database | › holds in the type and at the database | ✅ |
| F48 every historical version registered | › holds for every version ever shipped | ✅ |
| Each fails against a planted violation | › three planted-violation tests, fixtures under `fitness-fixtures/` | ✅ |
| Coverage config extended and verified failing | › sweep over correctness-bearing modules; found 12 missing on first run | ✅ |

### M2-35 · EXT-03
| Criterion | Test | |
|---|---|---|
| Seven-rule set scores a multi-correct paper | `golden-regression.spec.ts` › `synthetic-jee-advanced-partial-credit` | ✅ |
| Every graded band exercised | Fixture carries +4/+3/+2/+1/−2/0 | ✅ |
| Zero non-data files change | `git show --stat` over the adding commit: 1 file, JSON only | ✅ |
| `PER_CORRECT` exercised somewhere | `score-attempt.spec.ts` › PER_CORRECT describe (6 cases) | ✅ |

---

## Findings

| # | Severity | Finding |
|---|---|---|
| **F-1** | **Blocking** | **M2-30 has no test and cannot have one.** No released papers with official keys exist. The golden CI gate runs and proves regression-freedom against synthetic fixtures only — it proves nothing about agreement with a real key. Carried as a blocking gate with a named owner in [M2-CLOSEOUT](M2-CLOSEOUT.md) Part 4 |
| **F-2** | **Medium — FIXED** | The outbox emitter had no test: §9 rule 4 was asserted for curriculum and *assumed* for scoring. `outbox-emitter.integration.spec.ts` now writes an event inside a transaction and rolls back, proving the event goes with it — the one thing write-then-publish cannot do. Also asserts the aggregate mapping, decimal-text totals, absence of key material and PII, and that the row is left unpublished for the relay |
| **F-3** | Low | §9 rule 11 grants are revoked conditionally on `questionbank_app` existing. That role does not exist locally, so the revoke is never exercised — the triggers are what actually bind today. Closes with M0 |
| **F-4** | Low | M2-27's criterion says Zod schemas are *generated*; they are hand-written and kept in step by the contract spec. The spec catches drift, but the criterion as written is not met |
| **F-5** | Low | "Expected marks recorded independently of the executor" (M2-29) is enforced by authoring convention and review, not by a test. A future contributor could generate a fixture from the code it is meant to check |
| **F-6** | Low | Two criteria are asserted by inspection rather than by test: that ADR-0006 exists (M2-12), and that snake_case↔camelCase mapping happens only in the repository (M2-20) |
| **F-7** | **Medium — FIXED, found by M0-11** | **M2-20's "save → load deep-equal" row (above) was blind to `examProfileVersionId`/`taxonomyVersionId`.** Neither field existed on the domain `ScoreRecord` — the repository took them at construction instead and wrote them to real columns, but `toScoreRecord` never read the columns back, so the loaded object and the in-memory `record` the test compared it to were both missing the fields, identically. The deep-equality assertion was real and passing; the criterion it claimed to prove was not fully checked. Composing scoring's handlers into one shared instance (M0-11) surfaced this: a single repository instance fixed at construction can only ever be correct for one exam profile. Fixed in `fix(scoring): a score record carries the pin that produced it` — `ScoreRecord` now carries both fields, the repository reads and writes them like any other column, and the round-trip test asserts them by name in addition to the blanket `toEqual`. [ADR-0017](../adr/ADR-0017-a-score-record-carries-its-own-pin.md) records the reversal |

F-2 and F-7 were real untested guarantees rather than documentation gaps, so
both were fixed rather than carried — F-2 during the M2 close-out audit, F-7
during M0-11 when composing scoring's handlers surfaced it. The remaining
⚠️ items are documentation or environment gaps; none of them hides a
behaviour nobody has checked. F-1 is the blocking gate.
