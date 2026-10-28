# Implementation Roadmap
**Version:** 1.0 · **Date:** 2026-08-05 · **Status:** Draft
**Phase:** 10 — Execution Plan · **Team assumption:** 2–5 engineers, 6–12 months to public launch

> Every milestone is independently deployable to staging. Durations assume 3 engineers; scale roughly inversely.

---

## 0. Two Sequencing Rules

**1. The content factory precedes the storefront.** Milestones M1–M5 ship no student-facing feature. This is deliberate: content is the long pole and the moat, and a student UI over an empty bank is a demo, not a product.

**2. Correctness infrastructure precedes the code it constrains.** Fitness functions land in M0 and the scoring golden set lands in M2 — both before the systems they govern exist. Retrofitting a correctness gate onto working code is a project nobody finishes.

**The real critical path is content, not code.** Human authoring and AI generation begin the moment the review workspace exists (M4) and run continuously alongside every subsequent milestone. The engineering could finish in month 9 and launch could still be blocked on a 25,000-item corpus. Staff the content pipeline as a parallel workstream from M4, not as a launch-month scramble.

---

## M0 — Walking Skeleton
**3 weeks** · Deployable: staging environment serving a trivial authenticated request

**Goal** Establish the constraints before there is code to constrain.

**Deliverables**
- Docker Compose stack: Postgres, Valkey, MinIO, fixture AI provider
- Monorepo (Turborepo), Core API skeleton with one module, Learn and Studio app shells
- CI pipeline with fitness functions F1, F2, F5, F7, F8, F11, F16, F24, F26, F39
- Terraform for staging; one deployable to ECS Fargate
- OpenTelemetry wiring end to end; structured logging with allowlist serializer
- Auth stub (token issue and verify only)

**Acceptance**
- `docker compose up` → full stack healthy in ≤ 10 min on a clean machine
- One request traced from client through API to database in Grafana
- Every listed fitness function fails a deliberately-planted violation
- Staging deploy from a green main in ≤ 15 min

**Testing** Unit harness operational · CI gates blocking · Compose boot timed in CI

**Depends on** Nothing

---

## M1 — Curriculum Spine
**4 weeks** · Deployable: taxonomy and exam profiles queryable via API

**Goal** The versioned foundation every other context references.

**Deliverables**
- `ConceptIdentity`, `TaxonomyVersion`, `ConceptNode`, `PrerequisiteEdge`
- `Exam`, `ExamProfileVersion` with declarative `MarkingRuleSet`, `TimingPolicy`, `NavigationPolicy`
- JEE Main 2026 taxonomy (~600 concepts) and profile loaded as data
- `TaxonomyMigration` with dry-run and exception list
- Minimal Studio surfaces for taxonomy and profile management

**Acceptance**
- JEE Main 2026 profile passes schema validation and is immutable once published
- **NEET UG profile loads as pure configuration — zero code changes**
- Taxonomy migration between two versions produces a correct exception list
- Published taxonomy version rejects all mutation attempts

**Testing** Schema validation suite · migration dry-run correctness · immutability assertions

**Depends on** M0 · **Ratification of D-001** (`NumericAnswerSpec`)

---

## M2 — Scoring Engine + Golden Set
**4 weeks** · Deployable: scoring API accepting a synthetic attempt and returning a score record

**Goal** Lock the correctness invariant before anything can violate it.

**Sequenced here deliberately** — the scoring engine is a pure function over pinned versions and is fully testable against fixture papers long before authoring exists. Building it now means every later milestone inherits a correctness gate rather than negotiating with one.

**Deliverables**
- Declarative marking rule executor with `rule_schema_version` pinning
- `NumericAnswerSpec` evaluation: all five comparison modes, units, normalization
- `ScoreRecord` / `ItemOutcome` with rule attribution per item
- `RescoringOperation` with mandatory dry-run
- **Golden set: 3 released JEE Main papers with official answer keys as fixtures**
- Partial-credit rule support (unused by JEE Main; proves JEE Advanced absorption)

**Acceptance**
- **100% match against official keys on all 3 golden papers**
- Identical inputs produce byte-identical score records across 1,000 runs
- Every item outcome names the rule that produced it
- Re-scoring retains both generations; dry-run preview matches execution exactly
- A JEE Advanced partial-credit rule set scores correctly with zero code change

**Testing** **Golden-set regression blocking on every commit (F9)** · property-based numeric tolerance tests · 100% branch coverage on scoring (MNT-03) · determinism soak

**Depends on** M1

---

## M3 — Content Model & Authoring
**6 weeks** · Deployable: Studio authoring with drafts persisted and rendered

**Goal** The largest single milestone — the content substrate and the tool that fills it.

**Deliverables**
- `Item`, `Stimulus`, `Solution`, `MediaAsset` aggregates with independent versioning
- `ContentBody` structured markup; Temml math rendering; server-side chemistry SVG
- Studio authoring: dual-mode notation input, live mobile-width preview, autosave
- Taxonomy tagging, provenance, licensing status (publication-blocking)
- `content_media_ref` usage graph; alt text mandatory
- Bulk import with per-record validation
- Render validation across web, mobile, offline, and print (F20)

**Acceptance**
- An author produces a stimulus-linked set with equations and a labelled diagram in ≤ 20 min
- Preview matches student render byte-for-byte on the minimum device profile
- Publication blocked without tags, provenance, resolved licensing, or a solution
- Published versions reject mutation at the database level
- 500 items imported with a correct rejection report

**Testing** Visual regression on `ContentRenderer` · render validation suite · import fixture corpus · accessibility scan on the editor

**Depends on** M1, M2

---

## M4 — Governance & Review Workspace
**4 weeks** · Deployable: full authoring → review → publish loop, internal users only

**Goal** Unblock the content workstream — the true critical path.

**Deliverables**
- ~~Lifecycle state machine (FR-QM-01) with all transitions permission-gated~~ — **delivered by M3,
  not M4 (D20, [ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md))**. The machine
  lives in content's domain with an exhaustive 72-pair matrix; M4 built the workspace *against* it.
  *Amendment added 2026-08-26 at M4-45; D20 has been open since M3 and is closed by this line.*
- `ReviewAssignment` queue: subject-scoped, self-review prohibited, ageing escalation
- Review workspace: single screen, keyboard-driven, batched by concept, auto-advance
- `ReviewDecision` with fixed rejection taxonomy; approve-with-edits records both versions
- Duplicate detection: normalized hash + trigram + placeholder-normalized numbers
- ~~`ItemDefect` intake and triage~~ — **deferred to M5
  ([ADR-0022](adr/ADR-0022-item-defect-and-answer-key-challenge-move-to-m5.md))**. Trigger: the first
  published item a reviewer or author needs to report against. `AnswerKeyChallenge`, assigned to M4
  by M3's scope table, is deferred with it — trigger: the first disputed key on a published item, or
  M9's learner-facing surface, whichever comes first. *Amendment added 2026-08-26 at M4-45; the ADR
  is the decision, this edit is its consequence.*
- Audit hash chain with daily anchor — **sealed and HMAC-signed locally; not externally witnessed,
  and never described as notarization** ([ADR-0020](adr/ADR-0020-the-audit-chain-is-database-enforced-and-locally-anchored.md))

**Acceptance**
- **A reviewer sustains ≥ 40 items/hour on seeded content** (60 is the target; 40 is the gate)
  > **Status, added 2026-08-26 (M4-44, DEC-M4-5): `Fail — blocked` — no reviewer pool exists.**
  > Nothing in M4 measures human throughput. The interaction-cost, machine-time and
  > instrument figures M4 reports are evidence that the workspace does not itself
  > prevent the rate; they are not a measurement of it. What M4 does measure, and how
  > the wording of this gate is held to its status, is
  > `apps/api/src/testing/review/timing-criterion.spec.ts`.
- Self-review is impossible at both assignment and decision
- Every published item carries a reviewer signature
- Audit chain verification detects a planted tampering
- Duplicate detection catches same-question-different-constants

**Testing** ~~Timed reviewer session with 3 real reviewers~~ — **`Fail — blocked`, no reviewer pool
exists**, and no such session has been run · state machine exhaustive transition tests · audit chain
verification (F41) · authorization negative-path 100%

**Closed out** 46 of 46 tasks merged, 34 criteria: 21 pass, 2 partial, 6 blocked, 2 deferred,
3 carried. The blocked and carried lines are in [DEBT.md](DEBT.md).

**Depends on** M3
**Unblocks** ⚠️ **Human content authoring begins here and runs continuously**

---

## M5 — AI Generation Pipeline
**5 weeks** · Deployable: generation runs producing reviewed, published items

**Goal** Make content production economics work.

**Deliverables**
- `GenerationRun` / `GenerationCandidate` with grounded retrieval and batch API
- 12-check pre-check battery; blocking for AI content
- Independent answer verification (2 Opus solves + SymPy where symbolic)
- ACL translating accepted candidates into Content drafts
- `ModelVersion` / `PromptVersion` pinning; `EvaluationRun` promotion gate
- `AIBudget` enforced at enqueue; `ai_spend_ledger`
- Golden eval set: 250 real items + 100 known-bad

**Acceptance**
- **First-pass review acceptance ≥ 60%**
- **Zero AI content published without a recorded human approval (F27, F33)**
- **Verification catch rate ≥ 95% on known-bad items (F34)**
- Cost per published item ≤ 40% of the human-only baseline
- A model or prompt version cannot activate without a passing evaluation run (F31)

**Testing** Evaluation harness blocking promotion · adversarial prompt-injection suite (SEC-20) · budget-exhaustion behaviour · ACL boundary assertion

**Depends on** M3, M4

---

## M6 — Assessment Delivery & Offline Runtime
**6 weeks** · Deployable: full mock attempt, offline-capable, scored end to end

**Goal** The hardest technical milestone and the product's reliability promise.

> **Correction, 2026-10-20.** This milestone used to open with a warning that Phase 5 design had to complete first
> and was "currently undesigned". It is designed: `ASSESSMENT-ENGINE.md` covers the marking rule language, scoring
> execution, response projection, the attempt state machine, form assembly and equating, and its §14 closes with
> "Unblocks: Roadmap M6". The warning was left over and is withdrawn. M6 inherits the five assumptions and five
> unresolved questions §14 lists.

**Deliverables**
- `Form` assembly against blueprint; exposure ledger; scheduling and embargo
- Signed form package ≤ 3 MB, CDN-served, **verified key-free**
- **Attempt Engine**: framework-agnostic, append-only log, monotonic timer, sync queue
- Exam runtime UI: chrome-less, palette, calm sync indicator, auto-submit
- Idempotent submission; set-union conflict resolution; server-anchored deadline
- Async scoring pipeline via outbox; result publication

**Acceptance**
- **Zero response loss across 100 adversarial runs** — network kill, process kill, device switch, clock skew
- A full 3-hour mock completes on the minimum device profile (Android 9, 2GB, 3G)
- Complete backend outage mid-attempt loses nothing
- Memory ≤ 250 MB with no growth trend over 3 hours; battery ≤ 25%
- **Answer keys absent from every payload (F6, F35)** — blocking
- Result available ≤ 60s p95 after submission

> **Status, added 2026-10-26 (M6 close):** one criterion passes (answer keys absent), two are `Partial`, three are `Fail — blocked`
> (the device, a 3G link, a deployment). The headline criterion is `Partial`: a hundred seeded runs in a real Chrome lost no response, and a
> browser killed with no warning while the server is unreachable does lose what was in its write delay (D66). The table, with what each
> verdict rests on and what would unblock each, is [M6-ACCEPTANCE.md](M6-ACCEPTANCE.md).

**Testing** **Adversarial network + process-kill suite, blocking every release** · 3-hour soak on real devices · submission-storm load test at 3× peak · payload inspection · Attempt Engine unit tests with zero React imports (F26)

**Closed out** 60 of 60 tasks merged, 6 criteria: 1 pass, 2 partial, 3 blocked. The partial and blocked lines are in [DEBT.md](DEBT.md) (D66 to D68, D36) and [M6-ACCEPTANCE.md](M6-ACCEPTANCE.md).

**Depends on** M2, M3, M4 (needs published items) · **Phase 5 design**

---

## M7 — Learning Loop
**5 weeks** · Deployable: practice, diagnostics, and concept mastery — the product

**Goal** Convert diagnosis into action.

**Deliverables**
- `ConceptMap` with mastery computation per D-002 and verified-gain events
- Practice sessions (filtered + targeted remediation), immediate feedback
- Solution delivery with distractor-first explanation and effort gate
- Mock diagnostic report: findings ranked by mark impact, each with one-tap remediation
- Error notebook, bookmarks, spaced-repetition scheduling
- Time analytics distinguishing slow-and-correct from slow-and-wrong
- Home next-best-action surface
- Analytics event capture per the taxonomy

**Acceptance**
- Every concept state is traceable to the specific responses that produced it
- A verified mastery gain requires confirmation ≥ 48h later in a different session
- A diagnostic report is generated for every submitted mock, top finding within 60s
- **Mock result → remediation entry is one tap** *(met as written: one action on a finding makes a practice run about its concept and starts it, proved through the routes the report screen calls; the run's questions cannot yet be shown in the app, D87)*
- Event taxonomy conformance ≥ 99%

> **Status, added 2026-10-27 (M7 Tracks A and B):** the evidence seams are built ([ADR-0042](adr/ADR-0042-a-score-and-its-event-are-written-in-one-transaction.md),
> [ADR-0043](adr/ADR-0043-learning-reads-the-owning-contexts-through-two-seams.md), [ADR-0045](adr/ADR-0045-evidence-is-dated-by-the-response-and-assessment-offers-the-instant.md)),
> and Learning derives concept state from stored evidence dated by the response, with D-002's thresholds as versioned data, learner sittings, verified gains and
> regressions, consumed from the relay ([ADR-0046](adr/ADR-0046-the-relay-dead-letters-a-failure-retrying-cannot-mend.md)). Two acceptance lines have their mechanism and a test
> that could fail: every state traceable to its responses, and a verified gain needing forty-eight hours and a different sitting. **D72 is open:** a re-score
> never reaches Learning, so a corrected outcome does not correct the evidence. Practice, the report, the review schedule and the surfaces are Tracks C to H. DEC-M7-4
> is rejected and D2 stands: practice is the same `Attempt`, mode-parameterized.
>
> **Status, added 2026-10-27 (M7 Track D):** practice is storable and deliverable on that `Attempt`: the schema admits it by total constraints
> ([ADR-0048](adr/ADR-0048-the-attempt-admits-practice-by-constraint-not-by-exception.md)), a run's slot list grows while its pin only gains rows, targeted selection crosses one seam
> carrying concepts and never items, filtered selection runs over the published catalogue, immediate feedback serves a verdict and not the key
> ([ADR-0050](adr/ADR-0050-immediate-feedback-serves-a-verdict-and-not-the-key.md)), a run can be put down and picked up with no deadline, and every practice delivery is in the exposure
> ledger ([ADR-0049](adr/ADR-0049-a-practice-delivery-is-exposure-under-its-own-key.md)). **Open:** a practice submission is not scored and so does not yet move mastery (D77),
> feedback is judged under the first section's rules (D79), and remediation reads stored rather than decayed state (D76). D75 is closed; D80 records the runner-only adversarial seed.
>
> **Status, added 2026-10-30 (M7 Track E):** the response log can say a learner gave up on a question (`skip`, [ADR-0051](adr/ADR-0051-the-response-log-can-say-a-learner-gave-up.md)), and a
> solution is released per question, over stored facts, only after an attempt or a skip on that question — for a mock, also the submission. It is served on the first learner route that
> carries one, distractor-first ([ADR-0052](adr/ADR-0052-a-solution-is-served-only-through-a-gate-the-database-states.md)), and `KEY-FREE.md` gained its first row that asserts a solution is present. Learning keeps an error
> notebook cleared only by a verified mastery transition, and bookmarks that follow their item. **Open:** the notebook and bookmarks have no routes and the skip has no button (the learner
> surfaces are Track H), and the effort gate has no rate limit on skipping.
>
> **Status, added 2026-10-31 (M7 Track F):** a re-score now announces each attempt it superseded, in the transaction that supersedes it, and Learning corrects beside the evidence it holds and
> revokes a promotion granted on an outcome that changed ([ADR-0053](adr/ADR-0053-a-re-score-announces-each-attempt-it-superseded-and-learning-corrects-beside-the-record.md); D72 is closed).
> Every scored mock gets a diagnostic report whose findings are ranked by the marks each concept cost, skipped questions included (DEC-M7-21), with the practice run that would address each;
> a re-score gives a new report beside the old. Submission to top finding was measured at about a second through the real relay and scheduler. **Open, and not met:** "mock result to remediation
> in one tap" is proved at the handler level only, because the screens that tap are Track H2; the error notebook is not corrected by a re-score (D81); a large re-score queues ahead of
> live submissions (D82); and the studio specs' intermittent timeouts are registered with no cause (D83).
>
> **Status, added 2026-11-01 (M7 Track G):** the response projection says what the interval cap discarded (DEC-M7-22), so a five-minute think no longer reads as two minutes with nothing to show it, and
> time analytics read each slot as a pair of bounds: slow-and-correct, slow-and-wrong, fast, and *not known* where the loss could carry the time over the line
> ([ADR-0054](adr/ADR-0054-a-metric-that-lost-information-reports-that-it-did-and-does-not-guess.md), DEC-M7-23). "Slow" is a time per authored band in the rule set, published as version 2 of the
> platform default, as are the review values (DEC-M7-24). A review schedule is kept per concept, never per item, shortens on failure and is derived from evidence, so a re-score corrects it
> (D81 is restated: the schedule does not inherit it). A concept that lapses `escalateAtLapses` times is escalated to remediation once and not repeated (DEC-M7-25). **Open:** an escalation is
> never withdrawn (D85, closed at M7-54); the thresholds are chosen and not measured; none of this has a route until Track H1.
>
> **Track C (what the quarantine cost):** the key-free argument can no longer be satisfied by a skipped test ([ADR-0047](adr/ADR-0047-a-gate-reads-the-structure-of-the-test-it-names.md)), the attempt routes' key-free proof runs again,
> three coverage thresholds are back at 100, and the intermittent attempts spec is fixed and un-skipped: its 404 was never the application's (D73). Practice sessions are Track D.

>
> **Status, added 2026-11-02 (M7 Track H1):** Learning has an API layer. Eight routes, each the caller's own — report, pace, review plan, what to practise next, the error notebook with its cause, and bookmarks —
> and a learner asking for another's attempt gets the `404` an absent one gets. The anatomy gate now asks for source in each of the five directories (it was red on `learning/api/` before the layer existed), every
> one of the six contexts has one, and `learning-contract.spec.ts` makes an unrouted Learning handler a stated decision (DEC-M7-26). Practice has its three routes and the key-free surface covers them (D78 closed);
> an escalation is resolved by the fold that made it (D85 closed, DEC-M7-27). **Open:** the screens and "one tap" demonstrated end to end are H2 (D67, D68); a learner with more bookmarks than content answers for in one call
> gets no list (D86); D79 is untouched — a route does not change whose rules practice feedback is judged under.
>
> **Status, added 2026-11-03 (M7 Track H2):** the learner has three screens. The home screen names one next action, an escalated concept first, from the server's answers and no threshold of its own (DEC-M7-33); the report screen
> ranks findings by the marks they cost, each with the one tap to practise it, and shows the pace with the questions whose time is *not known* kept apart from fast and slow, and says when a paper was re-scored (DEC-M7-32); the
> practice screen shows the run the tap made. **The one tap is demonstrated end to end** against the real routes, from the top finding of a scored mock to a started run of items for that concept and no other (DEC-M7-31),
> and the run is as far as it goes: no route serves a run's questions, so the app starts a run it cannot show (D87), and the screens take the exam profile and taxonomy from the address and name concepts by identifier (D88).
> The resume path was wrong before the screens were built on it: `boot` read the device's record after two network calls, and a device with no log numbered from one. It reads the device first and resumes offline against a stored
> offset to the server's clock ([ADR-0055](adr/ADR-0055-a-reopened-app-reads-the-device-first-and-stands-its-clock-in-for-the-servers.md), DEC-M7-30; D67 closed), and the attempt route returns the log so a second device continues the
> numbering (DEC-M7-29; D68 closed). Content states its batch bound once and its two callers page at it (DEC-M7-28; D86 closed). **Open:** D66 wants real-device evidence; D84 is not closed by showing its label. The learner bundle
> grew by 13.6 kB raw and 3.9 kB gzipped and its budget was raised with the reason written in `bundle-budget.json`.

**Testing** Mastery state-machine tests against synthetic learner histories · diagnostic finding correctness on fixture attempts · event schema validation

**Depends on** M6

---

## M8 — Closed Beta Hardening
**4 weeks** · Deployable: **production, 200 invited students** *(PRD slice M1)*

**Goal** Real students, real load, no commerce.

**Deliverables**
- Full auth: registration, verification, recovery, sessions, device limits
- Onboarding → diagnostic → first concept map
- Search: structured, full-text, semantic (hybrid RRF)
- Notification pipeline with eligibility and suppression
- Support console (read-only on academic records)
- Production observability: SLO dashboards, burn-rate alerts, synthetic probes
- Rate limiting with burst and sustained tiers
- Load test at 3× projected peak

**Acceptance**
- Signup → first named weakness ≤ 10 min for ≥ 70% of beta users
- Mock completion rate ≥ 85%
- **Zero Sev-1 incidents over the beta period**
- p95 latencies within NFR §6
- On-call pages ≤ 2/week/person

**Testing** Full E2E journeys in CI · load + soak · security scan · WCAG 2.2 AA automated + manual · restore drill

**Depends on** M7

---

## M9 — Commerce & Public Launch
**5 weeks** · Deployable: **public production** *(PRD slice M2)*

**Goal** Take money, meet the law, open the doors.

**Deliverables**
- Plans, subscriptions, entitlement derivation, quota ledger
- Razorpay integration: UPI autopay, cards, netbanking; mandate lifecycle
- Invoicing with GST; refunds and credit notes
- Contextual paywall; free-tier quotas per D-C.7
- DPDP surfaces: age gate, guardian consent, retention, export, erasure
- Moderation intake, triage, sanctions, appeals
- Answer-key challenge and re-scoring operations
- Legal surfaces; Grievance Officer contact

**Acceptance**
- End-to-end purchase, renewal, cancellation, and refund all reconcile
- **Zero unreconciled payments beyond 24h**
- No card data in any schema or DTO (F42)
- Erasure completes ≤ 30 days with academic aggregates de-identified
- **Independent penetration test passed**
- **Third-party accessibility audit passed**
- DPIA complete and signed off

**Testing** Payment sandbox full lifecycle · reconciliation job · DPDP request simulation · pen test · accessibility audit · DR game day

**Depends on** M8 · **Requires §D items 2, 6, 7, 8 from DECISIONS.md** (licensing, refund policy, legal surfaces, Grievance Officer)

---

## M10 — NEET UG — The Architectural Acceptance Test
**3 weeks** · Deployable: second exam live

**Goal** Prove the multi-exam claim, or discover Phase 1 was wrong.

**Deliverables**
- NEET UG taxonomy (~900 concepts across Physics, Chemistry, Biology)
- NEET exam profile: 180 items, 200 minutes, +4/−1, single-correct only
- Biology content pipeline seeded
- Form assembly and scheduling for NEET

**Acceptance**
- **Zero core-domain schema changes**
- **Zero new item-type code**
- **≤ 10 person-days of engineering effort (EXT-01)**
- NEET forms score correctly against a released paper's official key
- No regression in any JEE Main metric

**Testing** Golden-set regression extended to a NEET paper · full E2E on the NEET path · schema-diff assertion against M9

**Depends on** M9 · Biology content availability

---

## M11 — Psychometrics & Adaptive *(H1, post-launch)*
**6+ weeks**

**Deliverables** IRT calibration · adaptive practice selection · predicted score with confidence intervals · multi-shift normalization
**Acceptance** Calibrated parameters stable across cohorts; adaptive selection outperforms filtered practice on measured mastery gain
**Depends on** M10 + sufficient exposure data (~6 months of live attempts)

---

## Sequencing & Parallelism

| Track | Milestones | Roles |
|---|---|---|
| **Content platform** | M1 → M3 → M4 → M5 | Backend + AI engineer |
| **Delivery & learning** | M2 → M6 → M7 | Backend + frontend |
| **Content production** ⚠️ | From M4, continuous | Authors + reviewers (non-engineering) |
| **Launch** | M8 → M9 → M10 | Whole team |

The content track must stay **one milestone ahead** of the delivery track — M6 needs published items to assemble forms.

**Critical path:** M0 → M1 → M2 → M3 → M4 → M6 → M7 → M8 → M9 → M10 ≈ **44 weeks**, or roughly 10 months at 3 engineers with no slack. M5 runs parallel to M6.

**Timeline risk is content, not code.** If the corpus target is 25,000 verified items and the pipeline produces 150/week from month 4, that is ~28 weeks of production — finishing *after* M9. Either the launch corpus target drops, the reviewer pool grows, or the launch date moves. This is the single largest schedule variable and it is currently unresolved (DECISIONS §D item 1).

---

## Gates Every Milestone Must Pass

| Gate | Applies from |
|---|---|
| All fitness functions green | M0 |
| Golden-set scoring regression 100% | M2 |
| Performance budgets within limits | M3 |
| Automated accessibility scan clean | M3 |
| Adversarial network + process-kill suite | M6 |
| No critical dependency vulnerability | M0 |
| Deploys to staging from green main | M0 |

A milestone is complete when it is **deployed to staging, passing every gate, and demonstrated end to end** — not when the code is merged.

---
