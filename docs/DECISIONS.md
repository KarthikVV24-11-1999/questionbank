# Decision Register
**Version:** 1.0 · **Date:** 2026-08-05
**Purpose:** Close every open item accumulated across Phases 0–3. Decisions here are binding unless explicitly reopened.

---

## A. Ratified Proposals

| ID | Decision | Status |
|---|---|---|
| **D-001** | `NumericAnswerSpec` as specified in [DOMAIN-MODEL.md](DOMAIN-MODEL.md) §12.1 — five comparison modes, unit handling, normalization before comparison | **Adopted.** Closes PRD M3. Thresholds are configuration; reversible without a model change |
| **D-002** | Concept mastery definition per [DOMAIN-MODEL.md](DOMAIN-MODEL.md) §12.2 — 8 responses / 4 items / 2 sessions / 80% recent accuracy, verified by 2 further correct responses ≥48 h later in a different session | **Adopted.** Closes PRD M6. Thresholds tunable per exam |

Both were presented for ratification and are now treated as decided. Reversing either is a configuration change, not a redesign — that was the point of specifying them as data.

---

## B. Newly Closed Decisions

### B.1 Domain & Data

| ID | Open item | Decision | Rationale |
|---|---|---|---|
| **D-003** | `MasteryEvidence` retention inside `ConceptMap` | Retain the **last 20 evidence items inline**; full history stays in the response log | Bounds aggregate size; 20 covers every promotion/decay computation |
| **D-004** | `AbuseSignal` placement | **Trust & Safety context**, fed by the analytics pipeline | It is a moderation input, not an analytics artifact; it needs a lifecycle and an audit trail |
| **D-005** | Locale-variant review model | **Lightweight translation review**, not a full independent `ReviewDecision`. Correctness is inherited from the authoritative source version; the translation reviewer attests to fidelity only | A translator is not re-adjudicating physics. Halves the localization cost of H1 |
| **D-006** | `Form` item substitution | **Permitted while `state = draft`; prohibited once published.** Immutability begins at publication, not at first attempt | The earlier boundary is simpler to reason about and removes a race between publication and the first attempt |
| **D-007** | `concept_state` write model | **In-place update**, with full event-sourced rebuild capability from `mastery_transition` + response log | 2 B rows updated per attempt is acceptable at ~50 concepts touched per attempt; rebuild capability protects against logic defects |
| **D-008** | `attempt_slot.current_response` | **Materialized projection**, rebuildable from `response_event` | Scoring and review read it constantly; deriving it per read is wasteful |
| **D-009** | `concept_state` hash partition count | **256**, not 64 | Hash partitions cannot be added later without rehashing everything. Over-provisioning now costs nothing (~8 M rows/partition at ceiling) |
| **D-010** | Hot-window length | **24 months**, not 18 | Covers a full Class 11→12 preparation cycle plus a dropper year. Cost delta is modest; the alternative silently hides a student's own history |
| **D-011** | `mastery_transition` retention | **Permanent**, never archived | It is the north-star metric's source of truth and is small (~thousands of rows per learner lifetime) |
| **D-012** | Read-replica topology | **Two replicas**: R1 projections/search/reports, R2 analytics export. **T0 reads never touch a replica** | Replica lag must never influence an examination |
| **D-013** | Statutory age threshold | **Under 18** — DPDP Act 2023 defines a child as a person under eighteen | A legal fact, not a design choice. Verifiable parental consent applies to a large share of the user base |

### B.2 Process & Operations

| ID | Open item | Decision |
|---|---|---|
| **D-014** | Extended-time accommodations | **Self-declared at profile level**, documentation requested only on dispute; Content Ops adjudicates. Applied as a `TimingPolicy` multiplier on practice and non-competitive mocks; **excluded from cohort statistics** so comparisons stay valid |
| **D-015** | Per-PR preview environments | **Not built.** Ephemeral database schemas inside shared staging instead | Largest avoidable cost at this stage (CST-01) |
| **D-016** | AI evaluation golden set | **250 items across all three subjects**, sourced from released papers with official keys, plus 100 known-bad items (wrong key, out of scope, duplicate, broken distractor) as negative controls. Grows continuously from reviewer rejection reasons and confirmed defects |

---

## C. Specifications Written to Close Gaps

### C.1 Incident Severity Model — closes PRD M16

| Sev | Definition | Ack | Contain | Comms |
|---|---|---|---|---|
| **Sev-1** | A student loses or cannot complete an attempt; incorrect scores published; data loss; PII exposure | 15 min | 4 h | Public status + direct notice |
| **Sev-2** | T0 degraded but no attempt lost; payments failing; auth degraded | 30 min | 8 h | Status page |
| **Sev-3** | T1 unavailable; content pipeline blocked; missed backup drill | 4 h | 3 days | Internal |
| **Sev-4** | T2/T3 degraded; cosmetic | Next business day | 2 weeks | Internal |

A defect against REL-01, REL-02, REL-03, or REL-04 is **Sev-1 regardless of blast radius** — including one student. Post-incident review within 5 working days for Sev-1/2, blameless, with an owned action list.

### C.2 Content Freshness Process — closes PRD M17

Triggered by a syllabus revision or exam-pattern change (both occur roughly annually).

1. **Detect** — Content Ops monitors the conducting body's notifications; a change opens a Freshness Cycle.
2. **Assess** — classify as taxonomy change, pattern change, or both. Pattern changes create a new `ExamProfileVersion`; syllabus changes create a new `TaxonomyVersion`.
3. **Map** — build `TaxonomyMigration` with dry-run and exception list (FR-QM-13).
4. **Disposition** — every removed concept's items are retired or re-tagged; every added concept enters the coverage gap dashboard as priority-1.
5. **Validate** — new profile version passes golden-set regression before activation (FR-ADM-03).
6. **Cut over** — new academic year's forms use the new profile; historical attempts remain pinned to theirs (INV-04).
7. **Communicate** — affected students notified of scope changes to their declared syllabus.

**Target:** a published syllabus change is fully reflected within **30 days**.

### C.3 Support & Escalation Model — closes PRD M12

| Tier | Owner | Scope | Target |
|---|---|---|---|
| **T0 Self-serve** | Help centre, in-app status | Password, subscription, sync questions | Deflect ≥ 60% |
| **T1 Support** | Support role | Account, billing, access, sync failures | First response ≤ 24 h |
| **T2 Content Ops** | Content Ops | Item defects, key challenges, re-scores | ≤ 72 h |
| **T3 Engineering** | On-call | Sev-1/2 incidents, data integrity | Per §C.1 |

Channels: in-app ticket (primary), email. **No phone support** — unsustainable at this ARPU and this team size.
**Grievance Officer** (CMP-05): named person, published contact, acknowledgement ≤ 48 h, resolution ≤ 30 days. *Requires appointment — see §D.*
Support holds **no mutation rights on academic records** (INV-09); every access to a user record is logged, including reads.

### C.4 Academic Integrity Policy — closes PRD M26

**Stance:** the platform measures learning; it does not police students.

- **Prohibited:** account sharing, systematic content extraction, submitting another person's attempt.
- **Detection:** behavioural signals only (FR-MOD-05). **No proctoring, no camera, no screen capture, no keystroke analysis, no biometrics** — permanently out of scope (PRD §12).
- **Consequence:** anomalous attempts are annotated and excluded from **cohort statistics**; the student's own result stands. Invalidating a personal result requires human review and a communicated reason.
- **No automatic sanctions.** Signals are advisory inputs to human moderation.
- **Published to students in plain language.** A rule students cannot read is not a rule.

### C.5 Experimentation Framework — closes PRD M20

Required before any learning-outcome claim is made externally.

- **Unit of assignment:** learner. Sticky across sessions and devices.
- **Assignment:** deterministic hash of `(user_id, experiment_key)` — no assignment service on a T0 path.
- **Instrumentation:** `experiment_key` and `variant` join the event envelope's `context` for every event during enrolment.
- **Guardrails:** every experiment declares guardrail metrics (mock completion rate, sync failure rate, cost per MAU). Breach auto-disables the experiment.
- **Prohibited:** experimenting on scoring correctness, answer keys, marking rules, accessibility, or anything that could disadvantage a student's actual result. **Correctness is never an A/B test.**
- **Minimum:** pre-registered hypothesis, primary metric, and duration before launch. No post-hoc metric selection.

### C.6 Reviewer Operating Model — closes PRD M22 *(mitigates R12, the most likely bottleneck)*

| Element | Decision |
|---|---|
| Engagement | Part-time contractors, subject-scoped, paid **per approved item** with a quality retainer |
| Rate | Set from measured throughput after the first 1,000 reviews — not guessed now |
| Capacity planning | Queue depth and ageing are tracked continuously (FR-RPT-03); staffing follows the queue, not the calendar |
| Quality control | 5% of approvals sampled by a second reviewer; sustained divergence triggers re-qualification |
| Throughput target | 60+ items/hour sustained (PRD §4 P4), enabled by single-screen context and keyboard-driven review |
| Load reduction | AI pre-checks are **blocking** for AI content — a reviewer never sees a candidate that failed answer verification |
| Escalation | Items ageing past threshold auto-escalate to Content Ops (FR-ADM-05) |

### C.7 Free-Tier Quotas — recommended defaults *(business confirmation invited, see §D)*

Chosen so the free tier is genuinely useful while satisfying CST-04 (≤ ₹1/MAU/month) and CST-06 (zero live AI inference).

| Capability | Free | Plus / Pro |
|---|---|---|
| Diagnostic | Full, plus one re-diagnostic per quarter | Unlimited |
| Practice items | **20/day** | Unlimited |
| Full-length mocks | **2/month** | Unlimited |
| Correct answer + basic explanation | **Always** (INV-08) | Always |
| Step-by-step solutions | 10/day, attempted items only | Unlimited |
| Distractor analysis, alternate approaches | ✗ | ✓ |
| Concept map | Full read, 30-day history | Full history + drill-down |
| Mock diagnostic report | Top 3 findings | Full report |
| Adaptive practice, AI tutor | ✗ | Pro |
| Live AI inference | **Never** (CST-06) | Pro, budgeted |

### C.8 Differentiation Statement — closes PRD M21

> **Everyone else tells you your score. We tell you why — and what to do about it tonight.**

Supporting position: incumbents compete on video lectures and brand teachers. We compete on **diagnosis**. Our moat is a structured, tagged, versioned question corpus with concept-level mastery tracking — an asset that compounds with usage and cannot be bought quickly with capital or acquired by hiring a famous teacher.

---

## D. Requires Your Input

These cannot be closed by architecture. Each blocks something specific.

| # | Item | Blocks | What I need |
|---|---|---|---|
| **1** | **Cold-start content plan** — item volume at launch and source split across licensed PYQ / in-house / AI | Sizes M0 entirely; the largest single scope variable | Target count and split |
| **2** | **Content licensing & IP policy** — what may be reproduced, under what attribution | Content acquisition; existential risk R5 | Legal counsel sign-off |
| **3** | **PDF / scanned-paper ingestion** — in or out of scope | At volume this is a substantial OCR + math-recognition subsystem, not a script | In or out |
| **4** | **Pricing validation** — ₹1,299 / ₹2,499 are untested hypotheses | The entire cost model (CST-03) is highly sensitive to this and to conversion rate | Market validation |
| **5** | **Free-tier quotas** — §C.7 defaults proposed | CST-04, CST-06, FR-PRA-09 | Confirm or adjust |
| **6** | **Refund & cancellation policy** | FR-PAY-07, CMP-05 | Business decision |
| **7** | **Legal surfaces** — T&C, privacy policy, AI and predicted-score disclaimers | Launch (CMP-11) | Legal counsel |
| **8** | **Grievance Officer** — a named person with published contact | CMP-05, statutory requirement | Appointment |
| **9** | **Teacher revenue share** — deferred as a feature, but ownership and attribution are modeled now | Author agreement terms (FR-TCH-01) | Directional intent |

Items 1 and 4 are the two that most change the plan. Everything else can proceed in parallel.

---

## E. Gap Status Summary

| Source | Total | Closed | Remaining |
|---|---|---|---|
| PRD §15 missing requirements | 27 | 24 | 3 *(licensing, PDF ingestion, cold-start)* |
| Phase 0 unresolved | 6 | 5 | 1 *(cold-start)* |
| Phase 0.6 (FRS) unresolved | 8 | 8 | 0 |
| Phase 0.7 (NFR) unresolved | 7 | 5 | 2 *(pricing, Grievance Officer)* |
| Phase 1 (Domain) unresolved | 6 | 6 | 0 |
| Phase 3 (Data) unresolved | 6 | 6 | 0 |
| **Skipped Phase 2** | 1 | 1 | 0 |

**All architectural and design gaps are closed.** The nine remaining items in §D are business, legal, or commercial — none blocks Phase 4.

---

## F. Document Set

| Document | Phase | Status |
|---|---|---|
| [PRD.md](PRD.md) | 0.5 | Complete |
| [FRS.md](FRS.md) | 0.6 | Complete — 118 features |
| [NFR.md](NFR.md) | 0.7 | Complete — 14 categories |
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md) | 1 | Complete — 51 aggregates |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 2 | Complete |
| [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) | 3 | Complete |
| [EVENT-TAXONOMY.md](EVENT-TAXONOMY.md) | — | Complete — 68 events |
| [DECISIONS.md](DECISIONS.md) | — | This document |

**Next:** Phase 4 — AI Architecture (generation pipeline, quality gating, embeddings, evaluation harness, cost governance).

---
