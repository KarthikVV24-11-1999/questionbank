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
  > prevent the rate; they are not a measurement of it. The session that would settle
  > this is specified in `docs/tasks/M4-REVIEW-TIMING-PROTOCOL.md`.
- Self-review is impossible at both assignment and decision
- Every published item carries a reviewer signature
- Audit chain verification detects a planted tampering
- Duplicate detection catches same-question-different-constants

**Testing** ~~Timed reviewer session with 3 real reviewers~~ — **`Fail — blocked`, no reviewer pool
exists**; the session is specified in [M4-REVIEW-TIMING-PROTOCOL.md](tasks/M4-REVIEW-TIMING-PROTOCOL.md)
and has not been run · state machine exhaustive transition tests · audit chain verification (F41) ·
authorization negative-path 100%

**Closed out** [M4-CLOSEOUT.md](tasks/M4-CLOSEOUT.md) · [M4-TRACEABILITY.md](tasks/M4-TRACEABILITY.md)
— 46 of 46 tasks merged, 34 criteria: 21 pass, 2 partial, 6 blocked, 2 deferred, 3 carried.

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

⚠️ **Phase 5 (Assessment & Adaptive Engine) design must complete before this starts** — the scoring runtime, session integrity model, and exposure/equating data capture are specified there and are currently undesigned.

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

**Testing** **Adversarial network + process-kill suite, blocking every release** · 3-hour soak on real devices · submission-storm load test at 3× peak · payload inspection · Attempt Engine unit tests with zero React imports (F26)

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
- **Mock result → remediation entry is one tap**
- Event taxonomy conformance ≥ 99%

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
