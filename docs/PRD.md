# Product Requirements Document
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 (Planning) · **Date:** 2026-08-05 · **Status:** Draft for review
**Phase:** 0.5 — follows Phase 0 (Product & Scope Framing), precedes Phase 1 (Domain Model)

---

## 1. Product Vision

**Every exam question becomes a structured, versioned, machine-understandable object — not a page in a PDF.**

The industry stores questions as unstructured blobs (scanned papers, images, HTML soup). That single fact is the reason adaptive learning, AI tutoring, semantic search, and psychometrics remain shallow across the category. We invert the order: build the content substrate first, and the intelligence layer becomes tractable rather than aspirational.

We launch with JEE Main, prove generality with NEET UG, and expand to any high-stakes examination without redesign.

**Positioning:** For serious aspirants who need to know *why* they are losing marks — not just *that* they are. A diagnostic engine, not a video library.

**Three-year vision:** the highest-quality structured question corpus for Indian competitive exams, with an AI layer that turns every wrong answer into a targeted, verified remediation path — and a content platform good enough that teachers choose to author on it.

---

## 2. Problem Statement

### 2.1 For Students
- Content is abundant; **diagnosis is absent**. Mock tests return a score and a rank, not a causal explanation of the score.
- No reliable path from *mistake* → *concept gap* → *targeted remediation*. Students self-diagnose, badly.
- Solutions are one-size-fits-all: a single official approach, no error-specific explanation, no alternate method, no addressing of *why the attractive wrong option was attractive*.
- Practice is unstructured. Students grind volume without knowing which 40 concepts actually gate their score.
- Quality coaching is expensive and geographically concentrated in a handful of cities.
- Silent-failure modes go undetected for months: chronic time mismanagement, negative-marking discipline, question-selection strategy.

### 2.2 For Teachers & Authors
- Authoring scientific content (equations, chemical structures, circuit diagrams, labelled figures) is slow and tool-hostile. Most authoring happens in Word or LaTeX and dies as a PDF.
- No reuse: the same concept is re-authored endlessly because nothing is retrievable by meaning.
- No quality feedback loop — an author never learns that item #4412 has a broken distractor that 60% of strong students select.

### 2.3 The Structural Problem (our actual thesis)
Every AI feature the category wants — adaptive sequencing, tutoring, generation, semantic retrieval, difficulty calibration — has the **same** upstream dependency: content that is structured, tagged, versioned, and linked to a concept graph. Nobody builds that first because it is unglamorous and slow. It is also the entire moat.

**The constraint is not AI capability. It is content structure.**

### 2.4 Market Context
- JEE Main: approximately 1.4M candidates annually. NEET UG: approximately 2.2M+. *(Figures approximate; validate before use in any external material.)*
- Incumbents (Physics Wallah, Allen Digital, Unacademy, Aakash, Vedantu) compete primarily on video content and brand teachers. Embibe is the nearest AI-native comparable.
- Market characteristics: mobile-first and Android-dominant, mid/low-tier devices, unreliable connectivity, high price sensitivity, low ARPU, and extreme seasonality tied to the exam calendar.

---

## 3. Target Users

| Tier | Segment | Notes |
|---|---|---|
| **Primary** | JEE Main aspirants, Class 11–12 and droppers | V1 focus. Droppers convert best: highest intent, own the purchase decision, highest willingness to pay. |
| **Primary** | NEET UG aspirants | Immediately post-launch. Larger volume; validates multi-exam architecture. |
| **Secondary** | Independent teachers & subject experts | Supply side. Content authors and reviewers. Small in count, critical in leverage. |
| **Secondary** | Parents | Payers for Class 11–12 segment; not users, but influence conversion and require a distinct trust surface. |
| **Tertiary (deferred)** | Coaching institutes, schools | B2B revenue line. Modeled in the domain, not built in v1. |
| **Tertiary (deferred)** | API consumers, edtech partners | Long-horizon distribution. |

---

## 4. User Personas

### P1 — "The Dropper" · Primary
- 18–19, taking a dedicated repeat year after a disappointing first attempt. Studies 8–10 hrs/day, self-directed.
- **Goal:** Convert a known score gap into a specific, ordered action list.
- **Pain:** Knows the syllabus, keeps losing the same marks, cannot identify the pattern. Has taken 40 mocks and learned little from any of them.
- **Behavior:** High-volume practice, analytical, will read a detailed diagnostic. Owns the purchase decision.
- **Success signal:** Can name their five weakest concepts and sees measurable improvement in those specific concepts within four weeks.

### P2 — "The Class 12 Student" · Primary
- 17, balancing board exams with entrance prep, likely also enrolled in offline coaching.
- **Goal:** Fill gaps left by classroom teaching, without adding another full-time commitment.
- **Pain:** Time-starved. Fragmented, overlapping resources. Cannot tell what is worth doing tonight.
- **Behavior:** Short mobile sessions, evenings and commutes. Low tolerance for setup friction. Parent pays.
- **Success signal:** Opens the app on a free evening without being prompted, because the next action is always obvious.

### P3 — "The Independent Teacher" · Secondary (Supply)
- 30s, subject specialist, 8+ years teaching, some private-tuition income, wants scale beyond a physical classroom.
- **Goal:** Author high-quality items and reach students without building a business.
- **Pain:** Authoring tools are hostile to scientific content. No distribution. No feedback on item quality.
- **Behavior:** Desktop authoring, batch sessions, deeply protective of subject accuracy.
- **Success signal:** Authors a full paragraph-linked set with equations and a labelled diagram in under 20 minutes, and later sees empirical performance data on it.

### P4 — "The SME Reviewer" · Secondary (Quality Gate)
- Senior subject expert, often a former exam topper or long-tenured faculty. Part-time, paid per reviewed item.
- **Goal:** Move a review queue efficiently without letting anything wrong reach students.
- **Pain:** Reviewing AI-generated content is a new and unstructured job; volume is high and context-switching is expensive.
- **Behavior:** Keyboard-driven, batch-oriented, needs full item context on one screen.
- **Success signal:** Sustains 60+ reviewed items/hour with a defensible audit trail on every decision.

### P5 — "The Content Ops Lead" · Internal
- Manages taxonomy, exam profiles, AI generation runs, reviewer throughput, and the answer-key challenge process.
- **Goal:** Grow the bank without letting quality regress.
- **Pain:** No visibility into where the content pipeline is stalled; syllabus revisions trigger mass re-tagging.
- **Success signal:** Can answer "how many verified items exist per concept, and where are the holes?" instantly.

---

## 5. User Journeys

### J1 — Onboarding → First Value *(target: under 10 minutes)*
Sign up → select exam + target year → select syllabus scope covered so far → short adaptive diagnostic (~20 items) → **concept-level strength map** → recommended first practice set.
**Critical:** value must be delivered *before* any paywall. The diagnostic map is the hook.

### J2 — Full-Length Mock → Diagnosis
Select mock → pre-flight check (network, offline cache, timer rules) → exam-accurate interface, 3 hours, free navigation, marking/review flags → submit (or auto-submit) → immediate score + subject/section breakdown → **diagnostic layer**: concept-level accuracy, time-per-item vs. cohort, negative-marking cost, question-selection quality, silent-failure flags → ranked remediation list → one-tap into targeted practice.

### J3 — The Core Learning Loop *(the product's atomic unit)*
Attempt item → wrong → see the correct approach **and** an explanation of why the chosen distractor was attractive → concept link → "practice 8 similar" → mastery re-check after a spaced interval → concept state updates on the strength map.

### J4 — Human Authoring
Author selects concept + item type → structured editor (equations, chemistry, diagrams) → attach or reuse stimulus → author solution → self-check → submit to review → reviewer approves / rejects / requests changes → published, versioned → live performance data flows back to the author.

### J5 — AI-Assisted Content Generation
Ops targets a concept gap → generation run with taxonomy + exemplar grounding → automated pre-checks (duplicate detection, answer verification, difficulty estimation, syllabus-scope check) → survivors enter the **same** review queue as human content, labeled with model, prompt version, and confidence → SME approves / edits / rejects → published with full provenance → rejection reasons feed prompt improvement.
**Invariant:** no AI-generated content reaches a student without a recorded human approval.

### J6 — Free → Paid Conversion
Free usage → hits a meaningful limit (mock quota, or depth of diagnostic) → contextual paywall at the moment of demonstrated value → plan selection → payment (UPI / card / netbanking) → instant entitlement → renewal reminders → grace period on failure.

### J7 — Offline Test-Taking
Pre-download mock → connectivity lost mid-attempt → responses persist locally with timing preserved → attempt completes normally → on reconnect, idempotent sync → server-side scoring → **zero data loss under any network condition**.

### J8 — Answer-Key Challenge
Student disputes a key → structured challenge with justification → ops triage → SME adjudication → if upheld: item corrected, rule set amended, **all affected attempts re-scored**, both results retained, affected students notified.

---

## 6. Business Goals

### Year 1
1. Prove the diagnostic loop measurably improves outcomes — the only durable differentiator.
2. Build a defensible corpus: 25,000+ verified, fully tagged JEE Main items with solutions. *(Target to validate.)*
3. Validate willingness to pay in a low-ARPU market; establish a positive unit-economics baseline.
4. Prove the multi-exam architecture by launching NEET UG at marginal cost.
5. Establish the AI content pipeline as a genuine cost advantage over pure human authoring.

### Structural (multi-year)
- Content corpus as the primary moat — compounding, hard to replicate, improves with usage.
- Cost-per-active-student low enough to make freemium sustainable at scale.
- Architecture that reaches millions of users through provisioning, never redesign.
- Optionality on B2B (institutes), API licensing, and adjacent exams — without re-platforming.

---

## 7. Success Metrics

**North Star: Weekly Verified Mastery Gains** — concepts moved from weak → strong and *confirmed* by later independent performance. Outcome-aligned and structurally hard to game.

| Category | Metric | Target |
|---|---|---|
| **Engagement** | Weekly Active Learners | TBD |
| | Sessions/week per active user | ≥ 4 |
| | D7 / D30 retention | TBD |
| | Mock completion rate (started → submitted) | ≥ 85% |
| **Learning Outcome** | Verified mastery gains / user / week | ≥ 3 |
| | Accuracy delta on remediated concepts (4 wks) | ≥ +15pp |
| | % of mocks where diagnosis → practice within 48h | ≥ 50% |
| **Content** | Verified items in bank | 25,000 by M12 |
| | Items fully tagged + provenance + license | 100% |
| | Item defect rate reaching students | < 0.1% |
| | Concept coverage (concepts with ≥ 20 items) | ≥ 90% |
| | Median author time per item | < 15 min |
| **AI** | AI item first-pass review acceptance | ≥ 60% |
| | AI content published without human approval | **0%** |
| | AI cost per published item vs. human-only | ≤ 40% |
| | Solution helpfulness rating | ≥ 4.0 / 5 |
| **Business** | Free → paid conversion | 3–5% |
| | Blended ARPU | TBD |
| | Infra cost per MAU | Envelope set in Phase 2 |
| | LTV : CAC | ≥ 3:1 |
| **Technical** | Mock delivery availability (peak windows) | 99.95% |
| | Response-data loss under network failure | **0** |
| | Scoring golden-set regression pass rate | **100%** |
| | p95 item render (mid-tier Android) | < 400 ms |

---

## 8. Monetization Strategy

**Model:** Freemium with a hard value-anchored paywall. Free tier must deliver genuine, non-crippled value — the diagnostic map is the acquisition mechanism, not a teaser.

| Tier | Indicative Price *(hypothesis — validate)* | Includes |
|---|---|---|
| **Free** | ₹0 | Diagnostic, limited daily practice, 2 full mocks, basic solutions, concept map (read-only) |
| **Plus** | ~₹1,299/yr | Unlimited practice, all mocks, full step-by-step solutions, full analytics, adaptive practice |
| **Pro** | ~₹2,499/yr | Plus + AI tutor, unlimited AI-generated targeted practice, predicted-score modeling, priority doubt resolution |
| **Institute** *(deferred)* | Per-seat | Cohort management, assignment, group analytics, white-label |

**Principles**
- **Annual-first.** Exam prep is seasonal and goal-bounded; monthly churn is structurally high. Price annual aggressively and quarterly as a bridge.
- **Never paywall correctness.** The right answer and a basic explanation are always free. Paywall depth, breadth, personalization, and AI — not truth.
- **Seasonal pricing.** Demand spikes 3–4 months pre-exam. Plan for it explicitly.
- **Cost discipline is a monetization strategy.** At ~₹1,300 ARPU, infra + AI cost per user must be low single-digit rupees per month. This directly constrains Phases 2–4.
- **Payments:** UPI-first (dominant and lowest-cost), cards, netbanking. Handle UPI autopay mandates, failure/retry, and GST correctly from day one.

**Deliberately rejected:** ads (wrong trust posture for education), per-question micropayments (friction, poor economics), and free-trial-with-card (kills top-of-funnel in this market).

---

## 9. User Roles

| Role | Scope | Key Capabilities |
|---|---|---|
| **Guest** | Public | Browse sample content, sign up |
| **Student** | Own data | Practice, mock, view solutions/analytics, raise challenges, manage subscription |
| **Author** | Own drafts | Create/edit items, stimuli, solutions; submit for review; view performance on own items |
| **Reviewer (SME)** | Assigned queue | Approve, reject, request changes, edit-in-review; sign off with audit trail |
| **Content Ops** | Global content | Taxonomy + exam profile management, generation runs, reviewer assignment, publishing control, key-challenge triage |
| **Support** | Scoped user data | View account/subscription state, issue credits, escalate. **No content mutation.** |
| **Platform Admin** | Global | User + role management, feature flags, system configuration |
| **AI Generation Agent** | System actor | Propose items/solutions. **Cannot publish.** Always attributed. |
| **AI Tutor Agent** | System actor | Explain, remediate. Read-only over published content. **Cannot author.** |
| **Institute Admin** *(deferred)* | Org-scoped | Cohorts, assignments, group analytics |
| **API Consumer** *(deferred)* | Contract-scoped | Programmatic access under quota |

**Design rules:** roles are additive (a user may be both Student and Author); every content-mutating action is attributable to a principal, human or machine; support can never silently alter academic records.

---

## 10. Feature Categories

These map deliberately to prospective bounded contexts, so Phase 1 inherits them cleanly.

1. **Content Authoring & Management** — structured scientific editor (LaTeX/MathML, chemistry, diagrams), stimulus reuse, solution authoring, versioning, media pipeline, bulk import, duplicate detection.
2. **Content Governance** — review workflow, state machine, SME assignment, audit trail, provenance, licensing status, defect reporting, key-challenge adjudication.
3. **Taxonomy & Curriculum** — versioned syllabus tree, concept graph, prerequisite relations, exam-profile-to-syllabus mapping, tag migration across syllabus revisions.
4. **Assessment Delivery** — form assembly, exam-accurate runtime, timing rules, navigation/marking, offline capture, idempotent sync, auto-submit, session integrity.
5. **Scoring & Psychometrics** — declarative rule engine, numeric tolerance, partial credit, re-scoring, item statistics, difficulty/discrimination, *(later)* IRT calibration and cross-form equating.
6. **Learning & Practice** — filtered practice, targeted remediation sets, spaced repetition, bookmarks/error notebook, *(later)* adaptive selection.
7. **AI Services** — item generation, solution generation, distractor analysis, difficulty estimation, semantic embedding, *(later)* conversational tutoring; plus the evaluation harness and cost governance that make all of it safe.
8. **Search & Discovery** — structured filtering, full-text, semantic/vector search, similar-item retrieval.
9. **Analytics & Insight** — student concept map, time analytics, mock diagnostics, silent-failure detection, cohort benchmarking, author/content analytics, ops dashboards.
10. **Identity, Access & Billing** — auth, RBAC, age gating and parental consent, subscriptions, entitlements, payments, invoicing.
11. **Engagement** — notifications, streaks, study planner, progress reporting.
12. **Platform & Operations** — feature flags, observability, admin tooling, experimentation, data export.

---

## 11. MVP Scope

**Definition of MVP:** a JEE Main aspirant can diagnose their weaknesses, practice against them, take faithful full-length mocks, understand exactly why they lost marks, and pay for more — while content ops can author and AI-generate a growing, governed, verified bank.

### Release Slices

**M0 — Internal Content Platform** *(no external users)*
Taxonomy + exam profile · structured authoring editor · review workflow · versioning · scoring rule engine + golden-set regression against released papers and official keys · AI generation pipeline v1 · admin tooling.
*Rationale: content is the long pole and the moat. Build the factory before the storefront.*

**M1 — Closed Beta** *(~200 invited students)*
Auth + onboarding · diagnostic · practice mode (filtered, non-adaptive) · full-length mock with exam-accurate UI · offline capture + sync · scoring + results · solutions · concept-level analytics · mock diagnostics · responsive web.

**M2 — Public Launch**
Subscriptions + payments + entitlements · free/Plus tiers · search (structured + semantic) · error notebook + spaced repetition · notifications · key-challenge workflow · support tooling · DPDP compliance surfaces · scale hardening for mock-window spikes.

**M3 — Multi-Exam Proof** *(the architectural acceptance test)*
NEET UG launch with **zero core-domain schema changes and no new item-type code**.

### MVP Item Types
Single-correct MCQ · numerical entry with tolerance · stimulus-linked sets. Nothing else.

### MVP Explicitly Excludes
Adaptive selection · AI tutor conversation · multilingual content · native apps · organizations · IRT · public API · teacher marketplace.

---

## 12. Out-of-Scope

### Deferred — modeled in the domain, not built
Organizations/institutes and cohorts · adaptive practice selection · IRT calibration and multi-shift equating · conversational AI tutor · public API · native iOS/Android · additional exams beyond JEE/NEET · multilingual content delivery · teacher marketplace and revenue share · JEE Advanced item types (multi-correct with partial credit, matching lists) · peer/community features · live classes or video · doubt-resolution marketplace.

### Rejected outright
- **Live proctoring with biometric surveillance** — poor accuracy, high cost, severe DPDP exposure with a minor-heavy user base, and not what this market pays for.
- **Ad-supported free tier** — incompatible with the trust posture education requires.
- **Adaptive full-length mocks** — pedagogically wrong for fixed-form exams; destroys score-prediction validity.
- **Scraped or unlicensed third-party content** — existential IP risk; the corpus is the moat and must be clean.

---

## 13. Risks

| # | Risk | Cat. | Impact | Likelihood | Mitigation |
|---|---|---|---|---|---|
| R1 | **Content cold-start** — insufficient quality items at launch; product is empty | Product | Critical | High | M0 precedes all user-facing work; AI generation + SME review from day one; launch narrow (2 subjects deep) rather than wide and thin |
| R2 | **AI generates plausible-but-wrong content** that reaches students | AI/Trust | Critical | High | Mandatory human approval (zero exceptions); automated answer verification; duplicate + scope pre-checks; defect reporting; published defect-rate SLO |
| R3 | **Wrong item model** discovered post-launch | Architecture | Critical | Medium | Phase 1 rigor; stimulus/solution/locale/provenance as first-class from day one; NEET launch as early falsification test |
| R4 | **Scoring correctness defect** | Correctness | Critical | Medium | Declarative versioned rules; golden-set regression on real papers every commit; re-scoring capability with dual-result audit trail |
| R5 | **IP/copyright exposure** from PYQ and publisher content | Legal | High | Medium | Licensing status as a mandatory first-class field; legal review of PYQ reproduction rights; provenance on every item; no scraping |
| R6 | **DPDP non-compliance** with a minor-heavy user base | Legal | High | Medium | Age gating + verifiable parental consent at signup; data minimization; retention and deletion policy pre-launch; GDPR-grade practices as superset |
| R7 | **Mock-window traffic spikes** overwhelm delivery | Scale | High | Medium | Spike profile (not average load) drives Phase 2; scheduled mocks are predictable — pre-scale; offline-first client absorbs degradation |
| R8 | **Unit economics fail** — infra + AI cost exceeds low ARPU | Business | High | Medium | Cost-per-MAU envelope defined in Phase 2 and tracked as a first-class SLO; AI cost governance in Phase 4; aggressive caching |
| R9 | **Incumbents with brand teachers and capital** out-distribute us | Competitive | High | High | Do not compete on video or brand; compete on diagnosis and content structure — the thing capital alone cannot buy quickly |
| R10 | **Offline sync complexity** causes data loss or duplicate attempts | Technical | High | Medium | Idempotency keys; local-first append-only capture; server-authoritative scoring; explicit conflict rules; adversarial network testing |
| R11 | **Syllabus revision** triggers mass re-tagging | Content | Medium | High | Versioned taxonomy with stable concept identity and mapping tables between versions |
| R12 | **SME reviewer throughput** becomes the pipeline bottleneck | Ops | High | High | Review UX optimized for batch keyboard workflow; AI pre-checks reduce reviewer load; measure and staff to queue depth |
| R13 | **Exam pattern changes** (both exams change frequently) | Product | Medium | High | Exam profiles versioned by academic year; attempts pin their profile version |
| R14 | **Key-person dependency** in a 2–5 person team | Org | High | Medium | Decisions documented per phase; no undocumented tribal architecture; boundaries enforced so ownership can transfer |
| R15 | **Seasonality** — revenue and usage collapse post-exam | Business | Medium | Certain | Multi-exam and multi-cohort portfolio; annual-first pricing; plan cash flow around the calendar |
| R16 | **Over-reliance on AI explanations** degrades learning | Ethics | Medium | Medium | Tutor scaffolds rather than answers; effort gating before revealing solutions; measure learning outcomes, not just engagement |

---

## 14. Future Expansion

**Horizon 1 (post-MVP, 6–12 mo)** — NEET UG · adaptive practice · AI tutor · native Android · multilingual content (Hindi first) · error-notebook intelligence · JEE Advanced item types.

**Horizon 2 (12–24 mo)** — Institutes/B2B with cohorts and white-label · IRT calibration and predicted-score modeling · teacher marketplace with revenue share · public API · adjacent exams (BITSAT, state CETs, Olympiads) · parent portal.

**Horizon 3 (24 mo+)** — New exam families (CAT, GATE, UPSC) as the real test of the multi-exam claim · content licensing to other platforms · full knowledge-graph-driven curriculum · international entrance exams · question-quality-as-a-service.

**Architectural implication:** Horizons 1–2 must require *no* core redesign. Horizon 3 may require new exam-profile plugins and new item-type modules — never changes to the core domain. If it does, Phase 1 was wrong.

---

## 15. Missing Requirements

Requirements not in the requested outline that this PRD is incomplete without. Ordered by cost-of-delay.

### 15.1 Must resolve before Phase 1 closes
| # | Gap | Why it cannot wait |
|---|---|---|
| M1 | **Non-functional requirements** — latency, availability, RTO/RPO, durability targets, concurrency ceilings | Drives every Phase 2 and 3 decision. "Fast" is not a requirement. |
| M2 | **Analytics event taxonomy** | Events not captured from day one are permanently lost. The entire diagnostic product depends on this. |
| M3 | **Numeric-answer correctness specification** — tolerance, significant figures, units, scientific notation, rounding | A core scoring invariant. Currently undefined and cannot be inferred. |
| M4 | **Content licensing & IP policy** — what may be reproduced, under what attribution, with what legal review | Blocks content acquisition. Existential risk (R5). |
| M5 | **Multi-shift normalization data capture** — item exposure, form identity, session, per-item timing | Not a v1 feature, but the data must be recorded from the first attempt or psychometrics has no history. |
| M6 | **Definition of "concept mastery"** | The north-star metric is currently unmeasurable without it. |

### 15.2 Must resolve before launch
| # | Gap |
|---|---|
| M7 | **Accessibility** — WCAG 2.2 AA target, screen-reader behavior for equations (MathML/aria), keyboard-only test-taking, and a low-end-device support floor |
| M8 | **Device & browser support matrix** — minimum Android version, RAM floor, offline storage budget |
| M9 | **Data retention, deletion & portability policy** — DPDP-mandated; includes academic-record retention after account deletion |
| M10 | **Age gating & verifiable parental consent flow** — legally required for minors under DPDP |
| M11 | **Subscription policy** — refunds, cancellation, grace periods, payment-failure handling, UPI mandate lifecycle, GST/invoicing |
| M12 | **Support & escalation model** — channels, SLA, tooling, who can see and do what |
| M13 | **Legal surfaces** — T&C, privacy policy, and explicit disclaimers on predicted scores and AI-generated content |
| M14 | **Notification strategy** — channels, frequency caps, quiet hours, consent (a minor-heavy base makes over-notification a real harm) |
| M15 | **Content moderation & abuse** — any user-generated surface (challenges, doubts, reports) needs a moderation path |
| M16 | **Incident response & observability requirements** — on-call, severity definitions, and the specific case of a mid-mock outage |
| M17 | **Content freshness process** — how a syllabus or exam-pattern change propagates through taxonomy, items, and profiles |

### 15.3 Should resolve before scaling
| # | Gap |
|---|---|
| M18 | **AI cost governance & fallback** — per-user and per-run budgets, degradation behavior when a model is unavailable, model-version pinning and migration policy |
| M19 | **AI evaluation harness** — how "good item" and "good solution" are measured, and the regression suite preventing prompt/model changes from silently degrading quality |
| M20 | **Experimentation framework** — A/B infrastructure; without it, the learning-outcome claims are unfalsifiable |
| M21 | **Explicit differentiation statement** — the one-sentence answer to "why not Physics Wallah?" |
| M22 | **Reviewer compensation & throughput model** — R12 is the most likely operational bottleneck and has no plan |
| M23 | **Cold-start content sourcing plan** — the specific split across licensed, in-house, and AI-generated, with volumes |
| M24 | **PDF/scanned-paper ingestion** — in or out? At volume it is a substantial OCR + math-recognition subsystem, not a script |
| M25 | **Teacher revenue share** — deferred as a feature, but affects the ownership and attribution model designed in Phase 1 |
| M26 | **Academic integrity policy** — the platform's own stance on answer sharing and account sharing |
| M27 | **Data residency** — India-only vs. multi-region; affects Phase 2 topology and Phase 6 compliance |

---
