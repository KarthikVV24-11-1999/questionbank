# Assessment & Adaptive Engine
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [DOMAIN-MODEL.md](DOMAIN-MODEL.md) §6–8 · [ARCHITECTURE.md](ARCHITECTURE.md) §5 · [DECISIONS.md](DECISIONS.md) D-001
**Phase:** 5 — Assessment & Adaptive Engine · **Blocks:** Roadmap M6

> The last design gap. Everything here has been referenced as "declarative", "server-authoritative", or "deferred to psychometrics" without being specified.

---

## 1. Scope

**Already decided:** `Attempt` / `Form` / `ScoreRecord` aggregates, offline capture and sync, exam runtime UX, scoring as an async worker, `NumericAnswerSpec` (D-001).

**Specified here:** the marking rule language, scoring execution semantics, response projection, attempt state machine, form assembly, item statistics, IRT calibration, adaptive selection, and equating — plus the data that must be captured from the first attempt or is lost forever.

---

## 2. The Marking Rule Language

This is the keystone. "Marking is declarative data, not code" (D6) has been asserted throughout; this is what that data is.

### 2.1 Structure

```
MarkingRuleSet {
  schema_version : int          // pinned into every ScoreRecord
  rules          : [MarkingRule] // ORDERED — first match wins
  aggregation    : AggregationSpec
}

MarkingRule {
  id          : string          // recorded in ItemOutcome.rule_applied_id
  applies_to  : { item_types[], section_ordinals?[] }
  condition   : Condition
  award       : Award
}
```

### 2.2 Conditions — a closed set, not an expression language

| Condition | Matches when |
|---|---|
| `UNATTEMPTED` | No response recorded for the slot |
| `EXACT_MATCH` | Single-correct option matches, or numeric within `NumericAnswerSpec` tolerance |
| `NO_MATCH` | A response exists and is wrong |
| `ALL_CORRECT_SELECTED` | Every correct option selected, no incorrect ones |
| `PARTIAL_CORRECT_SELECTED { min_correct, no_incorrect }` | At least *n* correct selected, subject to the incorrect constraint |
| `ANY_INCORRECT_SELECTED` | At least one incorrect option selected |
| `MATCHING_PAIRS_CORRECT { count }` | Exactly *n* pairs matched correctly |
| `ALWAYS` | Terminal default |

**This is deliberately not a general expression language.** JSONLogic, CEL, or an embedded interpreter would be Turing-adjacent, unauditable, and impossible to test exhaustively — an unacceptable property for the function that decides a student's exam score. Eight closed predicates cover every Indian entrance-exam pattern, are exhaustively testable, and make adding a ninth a deliberate, reviewed, versioned act.

### 2.3 Awards

| Award | Effect |
|---|---|
| `FIXED { marks }` | Award exactly this, positive or negative |
| `PER_CORRECT { marks }` | Marks × number of correct selections |
| `FULL_MARKS` | The slot's `marks_available`, regardless of response — for dropped and bonus items |

### 2.4 Worked expressions

**JEE Main / NEET UG** — three rules cover the entire paper:
```
1  UNATTEMPTED   → FIXED   0
2  EXACT_MATCH   → FIXED  +4
3  NO_MATCH      → FIXED  −1
```

**JEE Advanced multi-correct** — graded partial credit, in first-match order:
```
1  UNATTEMPTED                                        → FIXED   0
2  ANY_INCORRECT_SELECTED                              → FIXED  −2
3  ALL_CORRECT_SELECTED                                → FIXED  +4
4  PARTIAL_CORRECT_SELECTED{min:3, no_incorrect:true}  → FIXED  +3
5  PARTIAL_CORRECT_SELECTED{min:2, no_incorrect:true}  → FIXED  +2
6  PARTIAL_CORRECT_SELECTED{min:1, no_incorrect:true}  → FIXED  +1
7  ALWAYS                                              → FIXED   0
```

**This is the proof of EXT-03.** JEE Advanced arrives as seven rows of data — no code change, no migration, no deployment.

### 2.5 Item-level overrides

Applied **before** rule evaluation, at the form level:

| Override | Effect |
|---|---|
| `DROPPED` | Slot excluded from both awarded and available marks |
| `BONUS` | `FULL_MARKS` to every attempt, regardless of response |
| `KEY_CORRECTED` | New key applies; re-scoring re-evaluates normally |

Overrides are how an upheld answer-key challenge (FR-ADM-07) becomes a re-score without touching rules or code.

---

## 3. Scoring Execution

**Scoring is a pure function:** `(Attempt, AttemptPin, MarkingRuleSet) → ScoreRecord`

| Rule | Justification |
|---|---|
| **No clock, no randomness, no I/O inside the function** | Determinism (REL-03) is only provable if nothing outside the inputs can influence the output. |
| Execution order: overrides → per-slot rule evaluation → sectional aggregation → total | Fixed order removes the entire class of ordering bugs. |
| First matching rule wins; evaluation stops there | Makes every outcome attributable to exactly one rule. |
| Every `ItemOutcome` records `rule_applied_id` and a human-readable explanation | The score must be explainable to the student, item by item (FR-MOCK-07). |
| A slot matching no rule is a **hard error**, not a zero | A silent zero is an undetectable scoring defect; `ALWAYS` must be present. |
| `rule_schema_version` pinned alongside `marking_rule_set_hash` | The executor must support every historical schema version forever (R2). |
| Re-scoring is the same function with a different input; never a mutation | Dual-result retention (INV-11) becomes structural. |

**Numeric evaluation** applies `NumericAnswerSpec` per D-001: normalize the student's input first (whitespace, separators, Unicode minus, unit case), then compare under the declared mode. Normalization before comparison, never after.

---

## 4. Response Projection

The `ResponseEvent` log is authoritative; "the answer" is derived.

| Derivation | Rule |
|---|---|
| **Current answer** | Payload of the last `select` or `change` event for the slot, unless a later `clear` supersedes it |
| **Ordering within a slot** | Client-assigned `sequence` — monotonic per attempt, unforgeable in effect because the log is append-only |
| **Ordering across slots** | Server timestamp at ingest |
| **Time on item** | Sum of `visit` → `leave` intervals, capped per interval to discard backgrounded time |
| **Answer changes** | Count of `change` events — an analytics signal (FR-ANA-03) |
| **Flag state** | Last `flag` / `unflag` event |

| Rule | Justification |
|---|---|
| Projection is deterministic — the same log always yields the same answers | Scoring inherits determinism from projection, or it has none. |
| Device-switch merge is **set union by `event_id`**, never last-writer-wins | Two devices produce disjoint event sets; union cannot lose one (REL-06). |
| A duplicate `event_id` is silently ignored | Idempotent replay is the sync protocol's core property. |
| Events arriving after submission are recorded but excluded from scoring | Preserve the record; protect the result. |

---

## 5. Attempt State Machine

```
created ──▶ in_progress ──┬──▶ submitted    (manual)
                          ├──▶ submitted    (auto, expiry)
                          ├──▶ submitted    (recovered)
                          └──▶ abandoned    (window closed, no responses)
```

| State | Permitted | Prohibited |
|---|---|---|
| `created` | Package download, pre-flight | Response capture |
| `in_progress` | Response events, navigation, sync, submission | Form mutation, key access |
| `submitted` | Scoring, review, re-scoring | New response events |
| `abandoned` | Nothing | Everything |

| Integrity rule | Mechanism |
|---|---|
| Deadline is server-anchored and signed at start | Client clock manipulation cannot extend an attempt |
| Client enforces against **monotonic** time, not wall clock | Wall clock is user-settable |
| Server re-validates at submission; **the stricter of the two governs** | Offline expiry must not become a loophole |
| Submission is idempotent on `idempotency_key` | Retry cannot create a second attempt |
| One active mock attempt per student | Removes an entire class of ambiguity |
| Session expiry never ends an attempt | The attempt token is bound to the attempt, not the session |
| Recovery restores full state with elapsed time accounted | No recovery path may yield a lower score than the captured responses warrant |

---

## 6. Form Assembly

**Greedy selection with backtracking, not a constraint solver** — the eligible pool is large relative to the constraints, and a CSP solver is complexity without benefit at this ratio.

| Constraint | Type | Rule |
|---|---|---|
| Item count per section | **Hard** | Exact match to the blueprint |
| Item type mix | **Hard** | Exact |
| Total marks | **Hard** | Exact |
| Only published, non-retired items | **Hard** | — |
| No two items sharing a stimulus in different sections | **Hard** | Splits context |
| No near-duplicates within one form | **Hard** | Uses §8 detection |
| Difficulty distribution | Soft | Within tolerance of the blueprint target |
| Concept coverage | Soft | Maximize distinct concepts touched |
| Exposure balance | Soft | Prefer low-exposure items |
| **Anchor items** | **Hard** | **15% drawn from the anchor pool — see §10** |

Assembly writes to `ExposureLedger` at publication, not at attempt time — the form's composition is what determines exposure, and it must be known before students arrive.

A form becomes immutable at publication (D-006). Substitution is a draft-state operation only.

---

## 7. Item Statistics — Classical

Computed from real responses. The foundation for everything in §8–11.

| Statistic | Definition | Minimum n |
|---|---|---|
| **p-value** (difficulty) | Proportion answering correctly | 200 |
| **Point-biserial** (discrimination) | Correlation between item correctness and total score | 300 |
| **Distractor selection** | Selection rate per option, split by ability tercile | 300 |
| **Median time** | Median time-on-item among attempters | 100 |
| **Omit rate** | Proportion leaving it unattempted | 200 |

| Automatic flag | Meaning |
|---|---|
| Point-biserial < 0.10 | The item does not distinguish strong from weak students — probably broken |
| Point-biserial < 0 | Strong students do worse — **almost certainly a wrong key** |
| A distractor chosen more by the top tercile than the key | Probable key error, even when discrimination looks acceptable |
| Omit rate > 60% | Unclear, mis-scoped, or badly positioned |
| Median time > 3× section mean | Mis-scoped for the exam's timing |

| Rule | Justification |
|---|---|
| Nothing is reported below the minimum n | An unstable statistic presented as fact is worse than silence. |
| Empirical difficulty always supersedes the authored estimate | Reality beats estimation the moment it exists. |
| Flags auto-suspend nothing except a suspected key error | Suspension is a student-visible action; only correctness warrants it automatically. |
| Recomputed nightly, incrementally | Statistics are derived and fully recomputable (BAK-06). |

---

## 8. IRT Calibration

### 8.1 Model choice: 2PL

| Model | Verdict |
|---|---|
| 1PL (Rasch) — difficulty only | Fallback for items below the 2PL sample threshold |
| **2PL — difficulty + discrimination** | **Adopted** |
| 3PL — adds a guessing parameter | **Rejected** |

**Why 3PL is rejected — a domain argument, not a statistical one.** The guessing parameter models random guessing on multiple-choice items. JEE and NEET carry **negative marking**, which is designed precisely to suppress random guessing — and largely does. Estimating a parameter for behaviour the exam structure discourages produces a poorly-identified value that destabilizes the other two. Numeric-entry items have no guessing at all. 2PL is the right model for this exam family.

| Parameter | Notes |
|---|---|
| Estimation | Marginal Maximum Likelihood via EM |
| Sample per item | 500 for stable 2PL; 200 for 1PL fallback |
| Cadence | Monthly batch, never real-time |
| Linking across runs | Common-item (anchor) design — see §10 |
| Fit diagnostics | Item fit statistics; misfitting items excluded from the operational pool and flagged for review |

**Calibration output is advisory to content, authoritative to adaptive selection.** A poorly-fitting item is flagged for human review, not auto-retired.

---

## 9. Adaptive Selection *(H1)*

**Practice only. Mocks are fixed-form, permanently** (PRD §0.2).

### 9.1 The design decision that matters

Classical CAT selects the item with **maximum Fisher information** at the current ability estimate — which for 2PL means an item the student has roughly a **50% chance** of answering correctly. That is optimal for *measuring* ability and demoralizing for *learning* from it.

**We select for ~70% expected success probability instead.** Adaptive practice is item selection for learning, not ability estimation; measurement precision is a means, not the goal. A student who gets half of everything wrong stops practising.

### 9.2 Mechanics

| Component | Choice | Why |
|---|---|---|
| Ability estimate | **EAP** (Expected A Posteriori) | Defined after a single response; MLE is undefined for all-correct or all-wrong, which is common early. |
| Prior | Concept-specific, from the learner's `ConceptMap` state | Cold start at the concept's mean difficulty, never at θ=0. |
| Selection target | P(correct) ≈ 0.70 at current θ̂ | Zone of proximal development, not maximum information. |
| Exposure control | **Randomesque** — sample from the top-*k* candidates | Simple, adequate, and prevents every learner seeing the same items. |
| Content constraint | Restricted to the target concept set | Adaptivity must not drift off the concept being remediated. |
| Stopping | Fixed length, SE(θ̂) below threshold, or learner exit | Three legitimate reasons to stop. |
| Explainability | Every selection records its reason | FR-PRA-08 requires the learner can see why. |

**Fallback when uncalibrated:** items lacking IRT parameters are selected by empirical p-value band. Adaptive selection degrades to filtered practice rather than failing.

---

## 10. Equating & Normalization

**The problem:** two students take two different mock forms and expect comparable scores. Raw scores are not comparable across forms of differing difficulty.

**The method: common-item (anchor) equating.**

| Decision | Justification |
|---|---|
| **Every form carries 15% anchor items from a stable anchor pool** — from M6, before equating exists | Anchors cannot be retrofitted. A form assembled without them can never be equated to anything. This is the single most important data-capture decision in this document. |
| The anchor pool is reserved: excluded from practice, exposure-capped, rotated slowly | An anchor whose statistics drift is not an anchor. |
| Equating runs with monthly calibration | Not per-attempt; scores are provisional until the cohort completes. |
| Within-form percentile is available immediately; cross-form comparison waits for equating | Report what is defensible now, not what is desired. |
| Percentiles suppressed below minimum cohort size | A percentile from 30 students is a number, not information. |

**Multi-shift normalization** (the NTA method for JEE Main) is the same machinery: raw → within-session percentile → normalized score. We do not replicate NTA's scoring, but the same anchor data supports it if scheduled mocks ever run in multiple sessions.

---

## 11. Predicted Score *(H1)*

| Decision | Justification |
|---|---|
| Requires calibrated IRT **and** historical outcome data | A prediction without a validated mapping is a guess with a decimal point. |
| Always a **range with a stated confidence interval** | A point estimate of an exam score is a promise nobody can keep. |
| θ̂ → expected raw on a reference form → mapped to the historical distribution | Each step is separately verifiable. |
| Explicit disclaimer, always visible | Legally required (CMP-11) and ethically necessary. |
| Suppressed entirely below data sufficiency | No prediction is better than an unfounded one. |

---

## 12. Data Capture Requirements — Non-Deferrable

Every psychometric capability above depends on data that must be recorded from the **first attempt**. None can be reconstructed later.

| Must be captured from M6 | Enables | If missed |
|---|---|---|
| **Anchor items in every form** | All cross-form equating | Permanently unequatable forms |
| Per-item exposure with form and session identity | Equating, exposure control | No calibration linkage |
| Per-item response timing | Discrimination, time analytics, silent-failure detection | Analytics gaps |
| Full answer-change sequence | Behavioural analytics, integrity signals | Irrecoverable |
| Attempt-level session and shift identity | Multi-shift normalization | No normalization ever |
| Item version pinned per response | Statistics attributed to the correct version | Statistics silently mix versions |
| Ability estimates at each step *(practice)* | Adaptive validation | No way to evaluate the adaptive engine |

**These cost almost nothing to record and are impossible to reconstruct.** This is the concrete closure of PRD §15 M5.

---

## 13. Fitness Functions

| # | Check |
|---|---|
| F45 | The scoring function performs no I/O and reads no clock |
| F46 | Every `MarkingRuleSet` terminates in an `ALWAYS` rule |
| F47 | Every `ItemOutcome` carries a `rule_applied_id` |
| F48 | The executor handles every historical `rule_schema_version` |
| F49 | Response projection is deterministic over shuffled event arrival order |
| F50 | Every published form contains ≥ 15% anchor items |
| F51 | No statistic is exposed below its minimum sample size |
| F52 | Adaptive selection never runs on a mock-mode attempt |

---

## 14. Phase Closure

**Assumptions**
1. Anchor pool of ~300 items, sufficient for 15% of a 75-item form with rotation.
2. 500 responses per item for 2PL stability; reachable within one mock cycle at beta scale.
3. Monthly calibration cadence — a balance between freshness and estimation stability.
4. P(correct) ≈ 0.70 as the adaptive target; needs empirical validation against measured mastery gain.
5. Backgrounded time is excluded from time-on-item via a per-interval cap.

**Unresolved**
1. Anchor pool size and rotation policy — needs modelling against actual form volume.
2. Whether practice responses contribute to calibration, or only mock responses. Mock-only is cleaner (controlled conditions) but slower to accumulate.
3. Item-fit threshold for excluding items from the operational pool.
4. Whether adaptive practice targets a fixed 0.70 or adapts the target to the learner's demonstrated frustration tolerance.
5. Time-cap value for backgrounded intervals.

**Unblocks:** Roadmap **M6** — the assessment delivery milestone can now start.

---

## Document Set

| Phase | Document |
|---|---|
| 0.5 | [PRD.md](PRD.md) |
| 0.6 | [FRS.md](FRS.md) |
| 0.7 | [NFR.md](NFR.md) |
| 1 | [DOMAIN-MODEL.md](DOMAIN-MODEL.md) |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) · [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) · [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) |
| 3 | [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) |
| 4 | [AI-ARCHITECTURE.md](AI-ARCHITECTURE.md) |
| **5** | **This document** |
| 6 | [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) |
| 8 | [UX-ARCHITECTURE.md](UX-ARCHITECTURE.md) |
| 10 | [ROADMAP.md](ROADMAP.md) |
| — | [TECH-STACK.md](TECH-STACK.md) · [EVENT-TAXONOMY.md](EVENT-TAXONOMY.md) · [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) · [DECISIONS.md](DECISIONS.md) |

**Design is complete. All phases delivered.**

---
