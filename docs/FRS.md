# Functional Requirements Specification
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 (Planning) · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [PRD.md](PRD.md) v0.1 · **Phase:** 0.6 — precedes Phase 1 (Domain Model)

---

## 0. Conventions

**Release markers** — `M0` internal content platform · `M1` closed beta · `M2` public launch · `M3` multi-exam proof · `H1`/`H2` deferred horizons.

**Actor names** follow PRD §9: Guest, Student, Author, Reviewer, Content Ops, Support, Platform Admin, Institute Admin *(deferred)*, AI Generation Agent, AI Tutor Agent, System.

**"System"** denotes platform-initiated behavior with no human actor.

This document specifies *what* the system does. It contains no technology, storage, protocol, or algorithm decisions — those belong to Phases 1–5.

---

## 1. Global Invariants

Referenced by ID throughout. These may never be violated by any feature.

| ID | Invariant |
|---|---|
| **INV-01** | No AI-generated content becomes student-visible without a recorded human approval. |
| **INV-02** | Every content-mutating action is attributable to a principal (human or machine) and produces an immutable audit record. |
| **INV-03** | Published content is immutable. Corrections create new versions; prior versions are retained. |
| **INV-04** | Every attempt pins the exam profile version, item versions, and scoring rule version in effect at start. |
| **INV-05** | Scoring is server-authoritative. A client-computed score is never a score of record. |
| **INV-06** | Response capture is local-first and append-only. No network condition may cause response loss. |
| **INV-07** | Every published item carries taxonomy tags, provenance, licensing status, and a reviewer signature. |
| **INV-08** | Correctness is never paywalled. The correct answer and a basic explanation are available on every tier. |
| **INV-09** | Support roles may never mutate academic records (items, attempts, responses, scores). |
| **INV-10** | Accounts of minors require verified parental consent before any processing beyond account creation. |
| **INV-11** | Re-scoring retains both the prior and the new result, with the reason for change. |
| **INV-12** | An author may never review or approve their own content. |
| **INV-13** | Account deletion retains only de-identified aggregates required for psychometrics and legal obligation. |
| **INV-14** | An item renders identically in meaning across all surfaces (web, mobile, offline, print). |
| **INV-15** | Entitlement is evaluated server-side at the point of access, never trusted from the client. |

---

## 2. Authentication & Identity (FR-AUTH)

### FR-AUTH-01 · Account Registration `M1`
**Purpose** Create a platform identity.
**Actors** Guest → Student; System
**Inputs** Name, email and/or mobile, credential, date of birth, target exam, target year, consent flags
**Outputs** Unverified account, verification challenge, audit record
**Rules**
1. Date of birth is mandatory and drives the age gate (FR-AUTH-07).
2. Email or mobile must be unique across active accounts; a mobile number is required for the Indian market.
3. Account exists in `unverified` state with no access to academic features until FR-AUTH-02 completes.
4. Consent to terms and privacy policy is explicit, timestamped, versioned, and never pre-checked.

### FR-AUTH-02 · Contact Verification `M1`
**Purpose** Prove control of the registered email or mobile.
**Actors** Guest, System
**Inputs** Verification code, channel
**Outputs** Verified account state, audit record
**Rules**
1. Codes expire; attempts and re-sends are rate-limited per identifier and per source.
2. Failed attempts beyond a threshold lock verification for a cooling period.
3. Changing a verified contact re-enters the unverified state for that channel only.

### FR-AUTH-03 · Credential Login `M1`
**Purpose** Authenticate a returning user.
**Actors** All human roles
**Inputs** Identifier, credential, device context
**Outputs** Authenticated session, session record
**Rules**
1. Failure responses must not reveal whether the identifier exists.
2. Progressive rate limiting and lockout apply per identifier and per source.
3. Unverified accounts may authenticate but receive only the verification flow.
4. Suspended or deleted accounts are refused with a distinct, actionable message.

### FR-AUTH-04 · Federated Login `M2`
**Purpose** Reduce signup friction via a third-party identity provider.
**Actors** Guest, Student
**Inputs** Provider assertion
**Outputs** Authenticated session; new or linked account
**Rules**
1. Federated identities link to an existing account only after verified contact match.
2. Date of birth is still collected; the age gate is never bypassed.
3. A user may hold multiple linked identities but exactly one account.

### FR-AUTH-05 · Session Management `M1`
**Purpose** Maintain and terminate authenticated sessions.
**Actors** All human roles, System
**Inputs** Session token, device context, logout request
**Outputs** Session state, active-device list
**Rules**
1. Sessions expire on inactivity and on absolute lifetime; privileged roles use shorter limits.
2. Users may view active sessions and revoke any or all.
3. Credential change revokes all other sessions.
4. Concurrent session count is capped per subscription tier (see FR-AUTH-12).
5. An in-progress mock attempt survives session refresh without loss (INV-06).

### FR-AUTH-06 · Credential Recovery `M1`
**Purpose** Restore access to a locked-out user.
**Actors** Guest, System
**Inputs** Registered identifier, verification code, new credential
**Outputs** Updated credential, session revocation, notification
**Rules**
1. Response is identical whether or not the identifier exists.
2. Recovery tokens are single-use and short-lived.
3. Successful recovery revokes all sessions and notifies all verified channels.

### FR-AUTH-07 · Age Gate & Parental Consent `M2`
**Purpose** Meet DPDP obligations for users below the age of majority.
**Actors** Guest, Parent/Guardian, System
**Inputs** Date of birth; guardian contact; guardian consent confirmation
**Outputs** Consent record, restricted or full account state
**Rules**
1. Users below the statutory threshold require verified guardian consent before any processing beyond account creation (INV-10).
2. Consent is versioned, timestamped, revocable, and auditable.
3. Consent revocation restricts the account and initiates the retention policy.
4. Minors' accounts default to conservative notification, visibility, and data-sharing settings.
5. Behavioral advertising and profiling for non-educational purposes are disabled for minors — unconditionally.

### FR-AUTH-08 · Profile Management `M1`
**Purpose** Maintain user-supplied attributes.
**Actors** Student, Author, Reviewer, Content Ops
**Inputs** Display name, avatar, contact, exam and target year, language, timezone, syllabus scope
**Outputs** Updated profile, audit record
**Rules**
1. Date of birth is immutable after verification except via a Support-mediated, audited correction.
2. Changing target exam preserves all history; it does not reset progress.
3. Contact changes require re-verification of the changed channel.

### FR-AUTH-09 · Role & Permission Assignment `M0`
**Purpose** Govern what each principal may do.
**Actors** Platform Admin; System
**Inputs** User, role grant or revocation, scope, justification
**Outputs** Updated role set, audit record, notification
**Rules**
1. Roles are additive; a user may hold several simultaneously.
2. Permission is evaluated server-side at every access point (INV-15).
3. Every grant and revocation is audited with actor and justification.
4. Reviewer role requires a recorded qualification (FR-TCH-01).
5. No role permits self-approval of one's own content (INV-12).

### FR-AUTH-10 · Privileged-Role Step-Up `M2`
**Purpose** Raise assurance for destructive or wide-blast-radius actions.
**Actors** Content Ops, Platform Admin, Support
**Inputs** Second factor
**Outputs** Elevated session window, audit record
**Rules**
1. Required for role changes, bulk content operations, re-scoring, and takedowns.
2. Elevation is time-boxed and re-challenged on expiry.

### FR-AUTH-11 · Account Deactivation & Deletion `M2`
**Purpose** Honour the user's right to withdraw.
**Actors** Student, Support, System
**Inputs** Deletion request, confirmation, reason
**Outputs** Deactivated or deleted account, retained de-identified aggregates, confirmation
**Rules**
1. Deactivation is reversible within a defined window; deletion is not.
2. Deletion removes identifiers and de-identifies attempt records; aggregate item statistics survive (INV-13).
3. Authored content survives deletion with attribution replaced by an anonymized author reference.
4. Active paid subscriptions must be resolved (refund or forfeiture, per policy) before deletion completes.
5. Deletion requests are fulfilled within the statutory window and audited.

### FR-AUTH-12 · Concurrent Access Control `M2`
**Purpose** Limit credential sharing without punishing legitimate multi-device use.
**Actors** Student, System
**Inputs** Session and device context
**Outputs** Session allowed, displaced, or challenged; abuse signal
**Rules**
1. Active device count is capped by tier; the oldest session is displaced with notification.
2. Improbable concurrent-use patterns raise a moderation signal (FR-MOD-05), never an automatic ban.
3. Displacement never terminates an in-progress mock attempt.

### FR-AUTH-13 · Personal Data Export `M2`
**Purpose** Satisfy data portability.
**Actors** Student, System
**Inputs** Export request
**Outputs** Machine-readable archive of profile, attempts, responses, and analytics
**Rules**
1. Delivered via an authenticated, expiring channel — never an unauthenticated link.
2. Rate-limited per account.
3. Excludes other users' data and proprietary item content beyond the user's own responses.

---

## 3. Student Workflows (FR-STU)

### FR-STU-01 · Onboarding `M1`
**Purpose** Reach first value in under ten minutes.
**Actors** Student, System
**Inputs** Target exam, target year, current class, syllabus coverage, optional prior score
**Outputs** Configured learner profile, diagnostic invitation
**Rules**
1. No payment is requested during onboarding (PRD §5 J1).
2. Onboarding is resumable and skippable; skipping degrades recommendation quality but never blocks access.
3. Selected exam determines the applicable exam profile version (INV-04).

### FR-STU-02 · Syllabus Scope Declaration `M1`
**Purpose** Constrain content to what the student has actually studied.
**Actors** Student
**Inputs** Chapter/topic coverage selections
**Outputs** Active scope filter applied to practice and recommendations
**Rules**
1. Scope filters practice and recommendations; it never filters mock exams, which must remain faithful to the real paper.
2. Scope is editable at any time and is versioned against the taxonomy version.

### FR-STU-03 · Diagnostic Assessment `M1`
**Purpose** Establish an initial concept-level baseline.
**Actors** Student, System
**Inputs** Responses to a targeted item set
**Outputs** Initial concept strength map, recommended starting path
**Rules**
1. Fixed-length in M1; selection is breadth-first across high-leverage concepts within declared scope.
2. Available to all tiers without payment (PRD §8).
3. Results are provisional and superseded by accumulated evidence.
4. Abandonment produces a partial map from answered items.

### FR-STU-04 · Concept Strength Map `M1`
**Purpose** Show the student, at concept granularity, where they stand.
**Actors** Student
**Inputs** Attempt history, concept taxonomy
**Outputs** Per-concept state (unassessed / weak / developing / strong), confidence indicator, evidence count
**Rules**
1. Every state must be explainable: the student can see which attempts produced it.
2. States below a minimum evidence threshold are shown as low-confidence, not asserted.
3. State decays over time without reinforcing evidence.
4. Free tier sees the map; paid tiers see full drill-down and history.

### FR-STU-05 · Next-Best-Action Home `M1`
**Purpose** Remove the "what should I do now?" decision.
**Actors** Student, System
**Inputs** Concept map, spaced-repetition schedule, mock schedule, recent activity, available time
**Outputs** Ranked recommended actions with rationale
**Rules**
1. Every recommendation states why it was recommended.
2. Recommendations never exceed what the student's entitlement permits, and clearly mark gated items.
3. Overdue spaced-repetition reviews outrank new material.

### FR-STU-06 · Study Planner `M2`
**Purpose** Distribute preparation across time to the exam date.
**Actors** Student, System
**Inputs** Exam date, weekly availability, scope, current concept map
**Outputs** Plan with milestones; adherence tracking
**Rules**
1. The plan is advisory; the student may override any element.
2. Missed sessions trigger re-planning, never guilt-based escalation.
3. Plan revision preserves history for adherence reporting.

### FR-STU-07 · Error Notebook `M1`
**Purpose** Make every mistake a retrievable, actionable object.
**Actors** Student
**Inputs** Incorrect and flagged responses; student annotations; error-cause tags
**Outputs** Filterable collection of mistakes with linked concepts and remediation entry points
**Rules**
1. Every incorrect response is auto-added, with an optional student-supplied cause (conceptual / calculation / misread / time / guess).
2. Entries clear only when the concept is re-verified (FR-ANA-07), not on a single correct re-attempt.
3. Retained for the account lifetime.

### FR-STU-08 · Bookmarks `M1`
**Purpose** Let students set aside items deliberately.
**Actors** Student
**Inputs** Item reference, optional label
**Outputs** Bookmark collection
**Rules**
1. Bookmarks survive item re-versioning and resolve to the current published version.
2. Bookmarks of retired items are retained and marked retired.

### FR-STU-09 · Solution Access `M1`
**Purpose** Convert a wrong answer into understanding.
**Actors** Student, System
**Inputs** Item reference, attempt context
**Outputs** Correct answer, basic explanation, step-by-step solution, distractor analysis, alternate approaches, concept links
**Rules**
1. Correct answer and basic explanation are free on every tier (INV-08).
2. Step-by-step, distractor analysis, and alternate approaches are entitlement-gated.
3. In practice, solutions unlock only after an attempt or an explicit skip — never before (effort gate).
4. In mocks, all solutions are withheld until submission.
5. When the student's selected distractor has a recorded analysis, it is surfaced first.

### FR-STU-10 · Item Defect Report `M1`
**Purpose** Let students surface content errors.
**Actors** Student → Content Ops
**Inputs** Item reference, defect category, description
**Outputs** Defect record in triage queue, acknowledgement
**Rules**
1. Categories: wrong answer key, ambiguous wording, rendering fault, out of syllabus, duplicate, offensive content, other.
2. Reports are rate-limited per user; repeated frivolous reports raise a moderation signal.
3. Reporters are notified of the outcome (FR-QM-08).

### FR-STU-11 · Answer-Key Challenge `M2`
**Purpose** Provide due process on disputed correctness.
**Actors** Student → Content Ops → Reviewer
**Inputs** Item reference, attempt reference, claimed answer, justification
**Outputs** Challenge record, adjudication outcome, possible re-score
**Rules**
1. Requires a submitted attempt on the item and a written justification.
2. Filed within a defined window after result publication.
3. An upheld challenge triggers item correction and re-scoring of every affected attempt (FR-MOCK-10, INV-11).
4. Outcome and reasoning are communicated to the challenger.

### FR-STU-12 · Progress Dashboard `M1`
**Purpose** Show trajectory, not just current state.
**Actors** Student
**Inputs** Attempt history, mock results, concept map history
**Outputs** Trends in accuracy, speed, coverage, mastery gains, mock scores
**Rules**
1. Trends require a minimum data volume; below it, insufficient-data is stated rather than a misleading line drawn.
2. Comparison to cohort is opt-in and always anonymized (FR-ANA-06).

### FR-STU-13 · Goals & Streaks `M2`
**Purpose** Sustain consistent practice.
**Actors** Student, System
**Inputs** Goal targets, activity events
**Outputs** Streak state, goal progress, milestones
**Rules**
1. Goals are measured in meaningful work (items attempted with engagement), not app-open time.
2. Streak mechanics must not incentivize low-quality rushing; a rushed session does not count.
3. Streak protection is available to avoid punitive loss; streak loss never removes access to anything.

### FR-STU-14 · Subscription Self-Service `M2`
**Purpose** Let students manage their own commercial relationship.
**Actors** Student
**Inputs** Plan selection, upgrade, cancellation, payment method
**Outputs** Updated subscription and entitlements, confirmation, invoice
**Rules**
1. Cancellation is self-service and never requires contacting Support.
2. Cancellation retains access through the paid period; it is not immediate termination.
3. Upgrades take effect immediately with proration; downgrades take effect at renewal.

### FR-STU-15 · Notification Preferences `M2`
**Purpose** Give users control over contact.
**Actors** Student
**Inputs** Per-category, per-channel preferences; quiet hours
**Outputs** Preference record honoured by FR-NOT-02
**Rules**
1. Transactional notifications (payment, security, result) cannot be disabled.
2. Minors default to the most restrictive settings.
3. Preference changes take effect without delay.

---

## 4. Teacher & Author Workflows (FR-TCH)

### FR-TCH-01 · Author Onboarding & Qualification `M0`
**Purpose** Establish who is permitted to create and review content.
**Actors** Content Ops, Platform Admin
**Inputs** Identity, subject expertise, credentials, sample work, agreement acceptance
**Outputs** Author and/or Reviewer role grant, qualification record
**Rules**
1. Roles are scoped by subject; a Chemistry author cannot author Physics content.
2. Reviewer qualification is stricter than Author and separately granted.
3. Content ownership, licensing, and (future) compensation terms are accepted explicitly and versioned.

### FR-TCH-02 · Item Authoring `M0`
**Purpose** Create a structured, renderable, taggable item.
**Actors** Author
**Inputs** Item type, stem, options or answer specification, mathematical and chemical notation, diagrams, media, difficulty estimate, taxonomy tags, source, licensing
**Outputs** Draft item version
**Rules**
1. Content is captured as structured, renderer-agnostic markup — never as an image of text or pre-rendered markup (INV-14).
2. Supported v1 types: single-correct MCQ, numerical entry with tolerance. Stimulus-linked sets via FR-TCH-03.
3. Numerical items must specify tolerance, unit, and significant-figure handling; the item is invalid without them.
4. Every item requires at least one concept tag from the current taxonomy version.
5. Provenance and licensing status are mandatory before submission (INV-07).
6. Drafts autosave and are recoverable.

### FR-TCH-03 · Stimulus Authoring & Reuse `M0`
**Purpose** Model shared context across multiple items as a first-class object.
**Actors** Author
**Inputs** Stimulus content (passage, diagram, data set, reaction scheme), tags, licensing
**Outputs** Stimulus version; item-to-stimulus associations
**Rules**
1. A stimulus is independent of any item and may be referenced by many.
2. Editing a published stimulus creates a new version; existing item associations pin the prior version until explicitly migrated.
3. A stimulus may not be retired while published items reference it.

### FR-TCH-04 · Solution Authoring `M0`
**Purpose** Produce the explanatory content that carries the product's value.
**Actors** Author
**Inputs** Step-by-step derivation, final answer justification, alternate approaches, distractor analysis, concept links, common-error notes
**Outputs** Draft solution version linked to the item
**Rules**
1. No item may be published without at least a correct answer and a basic explanation (INV-08).
2. Distractor analysis is required for every incorrect option in MCQ items before a "complete" quality grade is assigned.
3. Solutions are versioned independently of the item; correcting a solution does not invalidate attempt history.

### FR-TCH-05 · Content Tagging `M0`
**Purpose** Make content retrievable, analyzable, and AI-groundable.
**Actors** Author, Content Ops, AI Generation Agent *(suggestion only)*
**Inputs** Concept tags, difficulty, cognitive level, estimated time, exam applicability, source year and paper
**Outputs** Tagged item version
**Rules**
1. Tags bind to a specific taxonomy version and migrate via FR-QM-13.
2. AI may suggest tags; a human confirms them before publication (INV-01).
3. Authored difficulty is an estimate and is superseded by empirical statistics once sufficient data exists (FR-QM-09).

### FR-TCH-06 · Draft Management `M0`
**Purpose** Support work in progress without polluting the bank.
**Actors** Author
**Inputs** Draft edits, deletion, duplication
**Outputs** Draft collection scoped to the author
**Rules**
1. Drafts are visible only to their author and Content Ops.
2. Drafts are never student-visible under any condition.
3. Deleting a draft is permanent and audited; deleting a submitted item is not permitted (withdraw instead).

### FR-TCH-07 · Pre-Submission Validation `M0`
**Purpose** Catch defects before they consume reviewer time.
**Actors** Author, System
**Inputs** Draft item and solution
**Outputs** Blocking errors, non-blocking warnings, render preview
**Rules**
1. Blocking: missing answer key, missing tolerance on numerical items, missing concept tag, missing licensing status, unrenderable notation, missing solution.
2. Warning: probable duplicate, out-of-declared-scope concept, unusual difficulty, missing distractor analysis.
3. Submission is refused while blocking errors remain.

### FR-TCH-08 · Submit for Review `M0`
**Purpose** Move content into governance.
**Actors** Author
**Inputs** Draft item, optional reviewer note
**Outputs** Item in review queue; state transition; audit record
**Rules**
1. Submission locks the draft against author edits until the review returns it.
2. The author may withdraw before review begins, not after.
3. The submitting author is excluded from the reviewer pool for that item (INV-12).

### FR-TCH-09 · Respond to Change Request `M0`
**Purpose** Close the loop on review feedback.
**Actors** Author, Reviewer
**Inputs** Reviewer comments, revised content
**Outputs** New draft version resubmitted for review
**Rules**
1. Revisions create a new version; reviewer comments persist against the version they addressed.
2. Re-review is routed to the original reviewer when available.

### FR-TCH-10 · Author Performance Dashboard `M2`
**Purpose** Give authors the empirical feedback loop the category lacks.
**Actors** Author
**Inputs** Published item statistics
**Outputs** Per-item exposure, accuracy, discrimination, time-to-answer, distractor selection distribution, defect reports, first-pass review acceptance rate
**Rules**
1. Only the author's own content is visible.
2. Statistics appear only above a minimum exposure threshold.
3. Items flagged as statistically anomalous are surfaced for author attention (FR-QM-09).

### FR-TCH-11 · Bulk Authoring Import `M0`
**Purpose** Migrate existing corpora efficiently.
**Actors** Author, Content Ops
**Inputs** Structured batch of items, stimuli, solutions, and tags
**Outputs** Validation report; created drafts; rejection list
**Rules**
1. Imported content enters as drafts and passes through the identical review workflow — no import bypasses governance.
2. Per-record validation; valid records import while invalid records are reported with reasons.
3. Every imported record carries provenance identifying the import batch and source.

### FR-TCH-12 · Reviewer Queue Workspace `M0`
**Purpose** Make review throughput a solved problem, not a bottleneck.
**Actors** Reviewer
**Inputs** Assigned queue, filters, decisions
**Outputs** Review decisions with rationale; throughput metrics
**Rules**
1. Item, stimulus, solution, tags, provenance, AI metadata, and duplicate candidates appear on a single screen.
2. Fully keyboard-navigable for batch operation.
3. Decisions: approve, approve-with-edits, request changes, reject. Rejection requires a categorized reason.
4. Approve-with-edits records both the pre-edit and post-edit versions (INV-02).
5. Queue assignment respects subject scope and the self-review prohibition (INV-12).

---

## 5. Admin Workflows (FR-ADM)

### FR-ADM-01 · User & Role Administration `M0`
**Purpose** Manage principals and their permissions.
**Actors** Platform Admin
**Inputs** User search, role grants and revocations, suspension, justification
**Outputs** Updated user state, audit record, notification
**Rules**
1. Every action requires a justification and produces an audit record (INV-02).
2. Role changes require step-up authentication (FR-AUTH-10).
3. An admin cannot alter their own role set.

### FR-ADM-02 · Taxonomy Management `M0`
**Purpose** Maintain the versioned curriculum spine.
**Actors** Content Ops
**Inputs** Subject/chapter/topic/concept definitions, prerequisite relations, version metadata
**Outputs** Published taxonomy version; migration mapping
**Rules**
1. Concepts hold stable identity across versions; versions record additions, removals, splits, merges, and moves.
2. A new version requires an explicit mapping from the prior version for every changed concept (FR-QM-13).
3. Published taxonomy versions are immutable.
4. Retiring a concept requires disposition of every item tagged to it.

### FR-ADM-03 · Exam Profile Management `M0`
**Purpose** Define each exam's structure, scoring, and delivery rules declaratively.
**Actors** Content Ops, Platform Admin
**Inputs** Section structure, item counts and types, timing, navigation rules, marking scheme, tolerance defaults, taxonomy mapping, applicable year
**Outputs** Versioned exam profile
**Rules**
1. Profiles are versioned by academic year; historical attempts score under the pinned version (INV-04).
2. A published profile version is immutable.
3. Marking rules are declarative — including negative marking, partial credit, and dropped-question handling — never embedded in code.
4. Every profile version must pass golden-set validation against released papers and official keys before activation (FR-MOCK-07).
5. Adding an exam must not require changes to core content or attempt structures (PRD §11 M3).

### FR-ADM-04 · Form Assembly & Mock Scheduling `M1`
**Purpose** Construct and release exam forms.
**Actors** Content Ops
**Inputs** Exam profile version, blueprint constraints, item pool, schedule window, availability rules
**Outputs** Assembled form, schedule, exposure record
**Rules**
1. Forms must satisfy the profile's blueprint exactly: counts, types, section distribution, difficulty spread.
2. Only published, non-retired items are eligible.
3. Assembly records item exposure for future equating (PRD §15 M5).
4. A form is immutable once any attempt against it exists.
5. Scheduled mocks may be embargoed until a release time; results may be embargoed separately.

### FR-ADM-05 · Review Queue Administration `M0`
**Purpose** Keep the content pipeline flowing.
**Actors** Content Ops
**Inputs** Assignment rules, reviewer capacity, priority, escalation
**Outputs** Assigned queues, queue-depth and ageing metrics
**Rules**
1. Assignment respects subject scope and the self-review prohibition.
2. Items ageing beyond a threshold escalate automatically.
3. Priority may be raised for concepts with identified coverage gaps (FR-ADM-11).

### FR-ADM-06 · Publishing Control `M0`
**Purpose** Govern what becomes student-visible and when.
**Actors** Content Ops
**Inputs** Approved items, publication scope, embargo
**Outputs** Published item versions; publication audit
**Rules**
1. Only reviewer-approved content is publishable (INV-01).
2. Publication is reversible via retirement (FR-QM-07), never via deletion.
3. Bulk publication requires step-up authentication.

### FR-ADM-07 · Challenge Adjudication `M2`
**Purpose** Resolve disputed correctness with due process.
**Actors** Content Ops, Reviewer
**Inputs** Challenge records, item, attempt data, SME opinion
**Outputs** Decision, item correction, re-scoring trigger, notifications
**Rules**
1. Challenges on the same item are grouped and adjudicated once.
2. Empirical response data (e.g. strong students disproportionately selecting one distractor) is presented to the adjudicator.
3. Outcomes: upheld (key corrected), upheld (item dropped), rejected. Each requires written reasoning.
4. An upheld outcome triggers FR-MOCK-10 automatically.

### FR-ADM-08 · Re-Scoring Operation `M2`
**Purpose** Correct scores of record safely and transparently.
**Actors** Content Ops
**Inputs** Affected item or rule change, attempt scope, reason
**Outputs** New scores, retained prior scores, notifications, audit record
**Rules**
1. Requires step-up authentication and a recorded reason.
2. Both results are retained with the change reason (INV-11).
3. Every affected student is notified with an explanation.
4. A dry-run impact preview (attempts and rank movement) is mandatory before execution.

### FR-ADM-09 · Configuration & Feature Flags `M1`
**Purpose** Control behavior without redeployment.
**Actors** Platform Admin
**Inputs** Flag definitions, targeting, values
**Outputs** Effective configuration; change audit
**Rules**
1. All changes audited with actor and prior value.
2. Flags may not alter scoring rules or content governance — those change only through FR-ADM-03 and FR-ADM-06.

### FR-ADM-10 · Support Console `M2`
**Purpose** Let Support resolve issues without academic-record access.
**Actors** Support
**Inputs** User lookup, subscription state, attempt metadata, ticket context
**Outputs** Account view, permitted actions, escalation
**Rules**
1. Read-only on academic data; no mutation of items, attempts, responses, or scores (INV-09).
2. Permitted: subscription adjustment, credit issue, session revocation, verification resend.
3. Every access to a user's record is logged, including reads.

### FR-ADM-11 · Content Coverage Dashboard `M1`
**Purpose** Direct authoring and generation effort where it matters.
**Actors** Content Ops
**Inputs** Taxonomy, item inventory, difficulty distribution, empirical statistics, demand signals
**Outputs** Per-concept coverage, gaps, quality distribution, prioritized generation targets
**Rules**
1. Coverage counts only published, non-retired items.
2. Gaps are ranked by student demand and exam weight, not by count alone.

### FR-ADM-12 · Audit Log Access `M1`
**Purpose** Make every consequential action reconstructable.
**Actors** Platform Admin, Content Ops *(content scope)*
**Inputs** Filters by actor, entity, action, time
**Outputs** Immutable audit trail
**Rules**
1. Audit records are append-only and never editable or deletable by any role.
2. Records capture actor (human or AI), action, entity and version, timestamp, and justification where required.
3. Reading audit logs is itself audited.

### FR-ADM-13 · Bulk Content Operations `M1`
**Purpose** Act on content at scale safely.
**Actors** Content Ops
**Inputs** Selection criteria, operation, justification
**Outputs** Impact preview, execution result, rollback point, audit record
**Rules**
1. Mandatory impact preview before execution.
2. Step-up authentication required.
3. Operations are reversible or explicitly flagged as irreversible before confirmation.

### FR-ADM-14 · Platform Announcements `M2`
**Purpose** Communicate scheduled events and incidents.
**Actors** Platform Admin, Content Ops
**Inputs** Message, audience, channel, schedule, severity
**Outputs** Delivered announcement; in-app banner
**Rules**
1. Announcements never interrupt an in-progress mock attempt.
2. Incident announcements bypass notification preferences; promotional ones never do.

---

## 6. Question Management (FR-QM)

### FR-QM-01 · Item Lifecycle `M0`
**Purpose** Govern every content state transition.
**Actors** Author, Reviewer, Content Ops, System
**Inputs** State transition requests
**Outputs** Current state; transition history
**Rules**
1. States: `draft` → `in_review` → (`changes_requested` | `approved` | `rejected`) → `published` → (`suspended` | `retired`).
2. Transitions are explicit, permission-gated, and audited; no implicit transitions.
3. Only `published` content is student-visible.
4. `suspended` immediately removes student visibility while preserving attempt history.
5. Content is never hard-deleted after leaving `draft`.

### FR-QM-02 · Content Versioning `M0`
**Purpose** Preserve historical truth while allowing correction.
**Actors** Author, Reviewer, Content Ops, System
**Inputs** Content edits
**Outputs** New immutable version; version history
**Rules**
1. Published versions are immutable (INV-03).
2. Attempts reference the exact version presented (INV-04).
3. Item, stimulus, and solution version independently.
4. Version history is fully retrievable with diffs and change reasons.

### FR-QM-03 · Review Workflow `M0`
**Purpose** Enforce the human quality gate.
**Actors** Reviewer, Content Ops
**Inputs** Item, stimulus, solution, tags, provenance, AI metadata, duplicate candidates
**Outputs** Decision, rationale, reviewer signature, state transition
**Rules**
1. Every published item carries a reviewer signature (INV-07).
2. Applies identically to human-authored and AI-generated content (INV-01).
3. Rejection reasons are categorized and feed AI prompt improvement (FR-AI-10).
4. Approve-with-edits records both versions.
5. Items above a configured risk profile require two independent approvals.

### FR-QM-04 · Duplicate Detection `M0`
**Purpose** Prevent corpus dilution.
**Actors** System, Author, Reviewer
**Inputs** Candidate item content
**Outputs** Ranked near-duplicate candidates with similarity rationale
**Rules**
1. Runs at authoring, at import, and on every AI generation candidate.
2. Advisory, never automatically blocking — genuine variants are legitimate and valuable.
3. Detection accounts for semantic equivalence, not only textual overlap.
4. Confirmed duplicates are linked, and one is retired with a pointer to the survivor.

### FR-QM-05 · Provenance & Licensing `M0`
**Purpose** Make every item's origin and reproduction rights explicit.
**Actors** Author, Content Ops, AI Generation Agent
**Inputs** Source type, exam/year/session/paper, author or model identity, licensing status, attribution
**Outputs** Immutable provenance record attached to the item version
**Rules**
1. Mandatory before publication (INV-07).
2. Source types: original, previous-year question, licensed third party, AI-generated, AI-assisted.
3. AI-generated items record model identity, prompt version, generation run, and confidence.
4. Items with unresolved licensing status may not be published — no exceptions.
5. Provenance is immutable once published; corrections create a new version.

### FR-QM-06 · Media Asset Management `M0`
**Purpose** Manage diagrams, figures, and images as governed content.
**Actors** Author, Content Ops
**Inputs** Asset, alt text, source, licensing, usage context
**Outputs** Versioned asset; usage references
**Rules**
1. Alt text is mandatory for accessibility (PRD §15 M7).
2. Assets carry independent licensing status.
3. An asset in use by published content cannot be deleted, only replaced via versioning.
4. Diagrams must render legibly at the minimum supported device size (INV-14).

### FR-QM-07 · Retirement & Replacement `M1`
**Purpose** Remove content from circulation without destroying history.
**Actors** Content Ops
**Inputs** Item, reason, optional replacement reference
**Outputs** Retired state; preserved history; redirected references
**Rules**
1. Retired items are excluded from new forms, practice, and search.
2. Existing attempt history, statistics, and student bookmarks are preserved and marked retired.
3. Retirement requires a categorized reason.
4. Retirement never alters previously issued scores; correcting scores requires FR-ADM-08.

### FR-QM-08 · Defect Triage `M1`
**Purpose** Convert reports into resolution.
**Actors** Content Ops, Reviewer, System
**Inputs** Student and internal defect reports
**Outputs** Triage decision, corrective action, reporter notification
**Rules**
1. Reports on the same item are grouped; volume raises priority.
2. Severity determines urgency; a wrong answer key is highest and auto-suspends the item pending review.
3. Every reporter receives an outcome notification.
4. Confirmed defects are tracked to the published defect-rate metric (PRD §7).

### FR-QM-09 · Empirical Item Statistics `M2`
**Purpose** Replace opinion about item quality with evidence.
**Actors** System, Content Ops, Author, Reviewer
**Inputs** Response data across attempts
**Outputs** Difficulty, discrimination, distractor selection distribution, time-to-answer, anomaly flags
**Rules**
1. Computed only above a minimum exposure threshold.
2. Empirical difficulty supersedes the authored estimate once available.
3. Negative or near-zero discrimination auto-flags the item for review.
4. A distractor selected disproportionately by high-performing students flags a probable key error.

### FR-QM-10 · Content Ingestion `M1`
**Purpose** Bring existing corpora into the structured model.
**Actors** Content Ops, System
**Inputs** Source batch, source metadata, licensing declaration
**Outputs** Draft items with provenance; validation and rejection report
**Rules**
1. All ingested content enters as drafts and passes full review.
2. Licensing status is declared per batch and per record; undeclared records are rejected.
3. Ingestion runs duplicate detection before creating drafts.
4. *(Scope of scanned/PDF ingestion is unresolved — see PRD §15 M24.)*

### FR-QM-11 · Localization Variants `H1` *(modeled in M0)*
**Purpose** Support multilingual delivery without re-modeling.
**Actors** Author, Reviewer, Content Ops
**Inputs** Locale, translated content, translator identity
**Outputs** Locale variant of an item version
**Rules**
1. Locale variants attach to a specific item version; the source version is authoritative for correctness.
2. Each variant requires independent review by a qualified reviewer in that language.
3. A correctness change to the source invalidates all variants until re-reviewed.
4. Modeled from day one; not delivered in v1 (PRD §11).

### FR-QM-12 · Exposure Control `M1`
**Purpose** Preserve the diagnostic value of items.
**Actors** Content Ops, System
**Inputs** Exposure records, item pool, usage policy
**Outputs** Exposure counts; eligibility for form assembly
**Rules**
1. Every presentation of an item to a student is recorded.
2. Items reserved for mock forms may be excluded from practice pools.
3. Exposure caps may restrict reuse within a defined window.

### FR-QM-13 · Taxonomy Migration `M1`
**Purpose** Survive syllabus revisions without mass re-tagging.
**Actors** Content Ops, System
**Inputs** Source and target taxonomy versions, mapping rules
**Outputs** Migrated tags; unmappable exception list
**Rules**
1. Automatic migration applies only to unambiguous 1:1 mappings.
2. Splits, merges, and removals produce an exception list requiring human disposition.
3. Migration is previewed before execution and is reversible.
4. Historical attempt analytics remain interpretable under the taxonomy version in force at attempt time.

### FR-QM-14 · Render Validation `M0`
**Purpose** Guarantee that what is authored is what students see.
**Actors** Author, Reviewer, System
**Inputs** Item version
**Outputs** Render preview across surfaces; validation errors
**Rules**
1. Validates notation, diagrams, and layout on web, mobile, offline, and print contexts.
2. A render failure on any supported surface blocks publication (INV-14).
3. Preview reflects the minimum supported device profile, not only a desktop view.

---

## 7. Practice (FR-PRA)

### FR-PRA-01 · Practice Session Creation `M1`
**Purpose** Let students practise deliberately against chosen content.
**Actors** Student, System
**Inputs** Subject, chapter/topic/concept, difficulty, item count or duration, source filter, exclusion of previously seen items
**Outputs** Practice session with a selected item set
**Rules**
1. Selection respects declared syllabus scope by default; the student may override.
2. Only published, non-retired, entitlement-permitted items are eligible.
3. Selection avoids recently seen items unless explicitly requested.
4. Session composition is fixed at creation and is reproducible.

### FR-PRA-02 · Targeted Remediation Set `M1`
**Purpose** Turn a diagnosis into immediate action.
**Actors** Student, System
**Inputs** Weak concept(s) from the concept map or mock diagnostic
**Outputs** Focused practice set with a difficulty ramp
**Rules**
1. Generated in one action from any weak concept or mock diagnostic finding.
2. Starts below the student's current demonstrated level and ramps up.
3. Prerequisite concepts are included when the concept graph indicates an upstream gap.
4. Completion feeds mastery verification (FR-ANA-07).

### FR-PRA-03 · Attempt & Response Capture `M1`
**Purpose** Record what the student did, precisely.
**Actors** Student, System
**Inputs** Selected option or numerical value, time spent, option changes, flags, skip
**Outputs** Immutable response record
**Rules**
1. Captures response, time-on-item, and answer-change sequence — all required by analytics.
2. Capture is local-first and survives interruption (INV-06).
3. Correctness evaluation is server-authoritative (INV-05).
4. Numerical responses evaluate against the item's declared tolerance, unit, and significant-figure rules.

### FR-PRA-04 · Immediate Feedback `M1`
**Purpose** Close the learning loop at the moment of maximum receptivity.
**Actors** Student, System
**Inputs** Response, item, solution
**Outputs** Correctness, correct answer, explanation, distractor analysis, concept link, next action
**Rules**
1. Available immediately after each response in practice mode; never in mock mode.
2. Depth is entitlement-gated; correctness and basic explanation are always free (INV-08).
3. On an incorrect response, the analysis of the specific distractor chosen is surfaced first.

### FR-PRA-05 · Spaced Repetition `M2`
**Purpose** Convert short-term correctness into retention.
**Actors** System, Student
**Inputs** Response history, concept state, elapsed time
**Outputs** Scheduled review items; due queue
**Rules**
1. Scheduling is per concept, not per item — the student must not merely memorize a specific question.
2. Reviews use different items covering the same concept.
3. Overdue reviews are prioritized in FR-STU-05.
4. Repeated failure shortens the interval and triggers remediation rather than more repetition.

### FR-PRA-06 · Session Pause & Resume `M1`
**Purpose** Fit practice into fragmented time.
**Actors** Student, System
**Inputs** Pause, abandonment, resume
**Outputs** Preserved session state
**Rules**
1. Practice sessions are pausable indefinitely and resumable on any device.
2. Timing accumulates only active time.
3. Abandoned sessions retain all answered responses; unanswered items are not penalized.

### FR-PRA-07 · Practice History `M1`
**Purpose** Make past work retrievable.
**Actors** Student
**Inputs** Filters by date, subject, concept, outcome
**Outputs** Session list with results and re-entry points
**Rules**
1. Every session is retained for the account lifetime.
2. Any past session is re-openable in review mode with solutions.

### FR-PRA-08 · Adaptive Selection `H1`
**Purpose** Select the item that maximizes learning value at each step.
**Actors** System, Student
**Inputs** Concept state, response history, item statistics, concept graph
**Outputs** Dynamically selected next item
**Rules**
1. Applies to practice only. Mock forms remain fixed (PRD §0.2).
2. Selection is explainable — the student can always see why an item was chosen.
3. Requires empirical item statistics (FR-QM-09) as an input; unavailable before sufficient exposure.

### FR-PRA-09 · Free-Tier Quota Enforcement `M2`
**Purpose** Create a fair, non-crippling free experience.
**Actors** System, Student
**Inputs** Entitlement, consumption counters
**Outputs** Permitted or gated action; upgrade prompt with context
**Rules**
1. Quotas are evaluated server-side (INV-15).
2. Quota exhaustion never interrupts an in-progress session.
3. Solutions to already-attempted items remain accessible regardless of quota (INV-08).
4. Prompts state exactly what is gated and what upgrading provides.

---

## 8. Mock Exams (FR-MOCK)

### FR-MOCK-01 · Mock Catalog & Scheduling `M1`
**Purpose** Present available mocks and their rules.
**Actors** Student, Content Ops, System
**Inputs** Available forms, schedule windows, entitlement, attempt history
**Outputs** Catalog with availability, duration, pattern, attempt state
**Rules**
1. Scheduled mocks are available only within their window; open mocks are always available.
2. Re-attempts are governed by policy and clearly marked as non-comparable to the first attempt.
3. Free-tier mock quota is stated before the student starts, never after.

### FR-MOCK-02 · Pre-Flight & Offline Preparation `M1`
**Purpose** Guarantee an uninterrupted three-hour attempt on an unreliable network.
**Actors** Student, System
**Inputs** Device and network state, storage availability
**Outputs** Downloaded form package, readiness confirmation, rule acknowledgement
**Rules**
1. The complete form — items, stimuli, and media — is available locally before the timer starts.
2. Insufficient storage or an incomplete download blocks the start with a clear remedy.
3. Exam rules (duration, marking, navigation) are displayed and acknowledged before start.
4. Solutions and answer keys are never included in the downloaded package.

### FR-MOCK-03 · Exam Runtime `M1`
**Purpose** Faithfully reproduce the real examination experience.
**Actors** Student, System
**Inputs** Form, exam profile version, responses, navigation and flag actions
**Outputs** Live attempt state, timer, question palette
**Rules**
1. Timing, navigation, section rules, and marking follow the pinned exam profile version exactly (INV-04).
2. JEE Main and NEET: single timer, free navigation across sections, no sectional locking.
3. Question palette shows per-item state: unvisited, answered, unanswered, marked for review, answered-and-marked.
4. Interface is exam-accurate; no hints, no correctness feedback, no solution access during the attempt.
5. The timer is server-anchored; client clock manipulation cannot extend the attempt.
6. The attempt continues uninterrupted through session refresh, network loss, and app backgrounding.

### FR-MOCK-04 · Offline Response Capture `M1`
**Purpose** Guarantee zero response loss.
**Actors** Student, System
**Inputs** Responses, timing, navigation events
**Outputs** Durable local response log; sync queue
**Rules**
1. Every response and timing event is persisted locally at the moment it occurs (INV-06).
2. The log is append-only; corrections are new entries, never overwrites.
3. Capture is fully functional with no network for the entire attempt duration.
4. Local data survives app termination and device restart.

### FR-MOCK-05 · Time Expiry & Auto-Submit `M1`
**Purpose** Enforce exam timing without penalizing the student for it.
**Actors** System, Student
**Inputs** Server-anchored elapsed time
**Outputs** Auto-submitted attempt
**Rules**
1. Warnings are issued at configured thresholds before expiry.
2. On expiry the attempt auto-submits with all captured responses.
3. Offline expiry is enforced locally and reconciled against server time on sync; the stricter of the two governs.
4. Auto-submission is never a data-loss event.

### FR-MOCK-06 · Submission & Sync `M1`
**Purpose** Move the attempt from device to system of record exactly once.
**Actors** Student, System
**Inputs** Local response log, attempt identity
**Outputs** Server-acknowledged submission; sync status
**Rules**
1. Submission is idempotent — repeated sync never creates a duplicate attempt or alters a result.
2. Submission may be attempted offline; it queues and completes automatically on reconnect.
3. The student sees unambiguous sync status; "submitted" is never displayed before server acknowledgement.
4. Conflicts resolve in favour of the complete local log; the server never silently discards captured responses.

### FR-MOCK-07 · Scoring Execution `M1`
**Purpose** Produce a correct, reproducible, auditable score.
**Actors** System
**Inputs** Attempt, responses, pinned item versions, pinned exam profile and scoring rule version
**Outputs** Score record with per-item outcomes and rule attribution
**Rules**
1. Scoring is server-authoritative and fully deterministic (INV-05).
2. Marking is driven by the declarative rule set of the pinned profile version — never by embedded logic.
3. Numerical evaluation applies declared tolerance, units, and significant figures.
4. Every scored item records which rule produced its outcome, making the score explainable to the student.
5. Dropped or bonus items are handled per the rule set, not by manual adjustment.
6. Every profile version passes golden-set regression against released papers and official keys before use (PRD §7).

### FR-MOCK-08 · Result Publication `M1`
**Purpose** Deliver results under controlled timing.
**Actors** System, Content Ops, Student
**Inputs** Score record, embargo settings
**Outputs** Published result; notification
**Rules**
1. Results for scheduled mocks may be embargoed until the window closes, enabling fair cohort comparison.
2. Results present total, sectional, and per-item outcomes with rule attribution.
3. Percentile and cohort comparison appear only above a minimum cohort size.
4. Publication triggers the diagnostic report (FR-ANA-02).

### FR-MOCK-09 · Attempt Review `M1`
**Purpose** Make the post-mortem the most valuable part of the mock.
**Actors** Student
**Inputs** Submitted attempt
**Outputs** Item-by-item review with response, correct answer, solution, time spent, and cohort comparison
**Rules**
1. Available only after submission and result publication.
2. Shows the student's own timing against cohort timing per item.
3. Every incorrect response links directly to remediation (FR-PRA-02).
4. Review presents the exact item versions the student saw (INV-04).

### FR-MOCK-10 · Re-Scoring Propagation `M2`
**Purpose** Correct historical results when a key changes.
**Actors** System, Content Ops
**Inputs** Corrected item or amended rule set, affected attempt scope
**Outputs** Revised scores, retained originals, notifications, revised rankings
**Rules**
1. Triggered by an upheld challenge (FR-ADM-07) or a confirmed key defect (FR-QM-08).
2. Both original and revised results are retained with the reason (INV-11).
3. Every affected student is notified with a plain-language explanation.
4. Cohort statistics and percentiles are recomputed.
5. Re-scoring never lowers a previously awarded score without explicit Content Ops confirmation of the policy applied.

### FR-MOCK-11 · Attempt Integrity `M1`
**Purpose** Keep results meaningful without surveillance.
**Actors** System
**Inputs** Attempt events, timing patterns, device context
**Outputs** Integrity signals; attempt annotations
**Rules**
1. No biometric monitoring, camera, screen, or keystroke surveillance — ever (PRD §12).
2. Detectable anomalies (impossible timing, systematic external-lookup patterns) annotate the attempt and may exclude it from cohort statistics.
3. Anomaly annotation never automatically invalidates a student's result; it routes to moderation review.
4. One active mock attempt per student at a time.

### FR-MOCK-12 · Interrupted Attempt Recovery `M1`
**Purpose** Survive real-world failure without penalty.
**Actors** Student, System
**Inputs** Incomplete attempt state, elapsed server time
**Outputs** Resumed attempt or recovered partial submission
**Rules**
1. Resumption within the original time window restores full state, with elapsed time correctly accounted.
2. An attempt interrupted past its window is submitted with all captured responses.
3. Device change mid-attempt is permitted; captured local responses on the original device sync and merge without loss.
4. No recovery path may result in a lower score than the responses actually captured warrant.

---

## 9. Analytics (FR-ANA)

### FR-ANA-01 · Concept Strength Computation `M1`
**Purpose** Maintain the per-concept state that drives the entire product.
**Actors** System
**Inputs** Response outcomes, timing, item difficulty, recency, concept graph
**Outputs** Concept state, confidence, contributing evidence
**Rules**
1. Weighted by item difficulty and evidence recency; recent evidence dominates.
2. States below the evidence threshold are reported as low-confidence, never asserted.
3. Every state is traceable to the specific responses that produced it (FR-STU-04).
4. Prerequisite weakness propagates as a signal to dependent concepts.

### FR-ANA-02 · Mock Diagnostic Report `M1`
**Purpose** Convert a score into a causal explanation. **This is the product.**
**Actors** System, Student
**Inputs** Attempt, responses, timing, cohort data, concept map
**Outputs** Concept-level accuracy, time allocation, negative-marking cost, question-selection quality, silent-failure flags, ranked remediation list
**Rules**
1. Every finding must be evidence-backed and drillable to specific items.
2. Findings are ranked by estimated mark impact, not by count.
3. Every finding links to a one-tap remediation action (FR-PRA-02).
4. Generated for every submitted mock; depth is entitlement-gated, the top findings are not.

### FR-ANA-03 · Time Analytics `M1`
**Purpose** Expose the time dimension students cannot self-observe.
**Actors** System, Student
**Inputs** Per-item timing, navigation sequence, cohort timing
**Outputs** Time distribution by subject/concept/difficulty, overtime items, abandonment patterns, pacing curve
**Rules**
1. Compares against both cohort norms and the student's own baseline.
2. Flags items where time spent was disproportionate to marks available.
3. Distinguishes slow-and-correct from slow-and-incorrect — these require opposite interventions.

### FR-ANA-04 · Marking Efficiency Analysis `M1`
**Purpose** Quantify the cost of poor attempt strategy under negative marking.
**Actors** System, Student
**Inputs** Responses, marking scheme, confidence signals
**Outputs** Marks lost to negative marking, guess quality, marks forgone by over-caution, net-benefit analysis
**Rules**
1. Computes both marks lost to wrong attempts and marks forgone by skipping answerable items.
2. Produces a concrete strategy recommendation, not a raw statistic.

### FR-ANA-05 · Silent Failure Detection `M2`
**Purpose** Surface chronic, invisible problems.
**Actors** System, Student, Content Ops
**Inputs** Longitudinal attempt patterns
**Outputs** Named failure patterns with evidence and intervention
**Rules**
1. Detects patterns such as chronic time mismanagement, systematic misreading, persistent calculation error, question-selection failure, and mastery illusion (correct-then-forgotten).
2. Raised only above a confidence threshold; a false accusation of a pattern is costly.
3. Every pattern carries a specific intervention, never a bare label.

### FR-ANA-06 · Cohort Benchmarking `M2`
**Purpose** Provide context without harm.
**Actors** System, Student
**Inputs** Anonymized cohort performance
**Outputs** Percentile, comparative accuracy and timing
**Rules**
1. Always anonymized and aggregate; no individual is ever identifiable.
2. Suppressed below a minimum cohort size.
3. Comparison is opt-in and can be disabled permanently by the student.
4. Cohorts are defined by comparable attributes (exam, target year, form), never by demographics.

### FR-ANA-07 · Mastery Verification `M1`
**Purpose** Make the north-star metric measurable and honest.
**Actors** System
**Inputs** Concept state history, subsequent independent attempts
**Outputs** Verified mastery gain event
**Rules**
1. A gain is recorded only when a weak→strong transition is confirmed by later, independent evidence on different items.
2. Immediate post-remediation correctness alone is insufficient — it is confounded by recency.
3. A verified gain that later regresses is recorded as a regression, and the original gain is not silently deleted.

### FR-ANA-08 · Predicted Score Modeling `H1`
**Purpose** Give students a calibrated expectation.
**Actors** System, Student
**Inputs** Attempt history, item statistics, calibrated difficulty, historical outcome data
**Outputs** Predicted score range with a stated confidence interval
**Rules**
1. Always expressed as a range with confidence, never a point estimate.
2. Requires calibrated psychometrics (FR-QM-09) and sufficient historical data.
3. Carries an explicit disclaimer; it is not a guarantee (PRD §15 M13).

### FR-ANA-09 · Content & Author Analytics `M2`
**Purpose** Direct content investment with evidence.
**Actors** Content Ops, Author, System
**Inputs** Item statistics, coverage, review outcomes, defect data
**Outputs** Quality distribution, coverage gaps, author performance, review throughput, AI acceptance rates
**Rules**
1. Authors see only their own content; Content Ops see all.
2. Author metrics are for improvement, not ranking or public exposure.

### FR-ANA-10 · Behavioral Event Capture `M0`
**Purpose** Record the events every downstream analysis depends on.
**Actors** System
**Inputs** User interactions, system events, content events
**Outputs** Structured event stream against a governed taxonomy
**Rules**
1. Events conform to a defined, versioned taxonomy; ad-hoc events are not permitted (PRD §15 M2).
2. Capture begins at M0 — events not captured are permanently lost.
3. No personal data beyond the identifiers required for the analysis.
4. Minors' events are excluded from any non-educational profiling (INV-10).

---

## 10. Payments & Subscriptions (FR-PAY)

### FR-PAY-01 · Plan Catalog `M2`
**Purpose** Present commercial options clearly.
**Actors** Guest, Student, System
**Inputs** Plan definitions, pricing, region, active promotions
**Outputs** Plan comparison with feature entitlements
**Rules**
1. Prices display inclusive of taxes with the tax component itemized.
2. Feature differences are stated explicitly; no hidden gating.
3. Plan definitions are versioned; existing subscribers retain their subscribed terms.

### FR-PAY-02 · Checkout `M2`
**Purpose** Complete a purchase reliably.
**Actors** Student, System
**Inputs** Plan, billing details, payment instrument, promo code
**Outputs** Payment outcome, subscription record, invoice, entitlement grant
**Rules**
1. Supported: UPI (including autopay mandate), cards, netbanking, wallets.
2. Entitlement is granted only on confirmed payment; pending states grant nothing.
3. Checkout is idempotent — a retry or double submission never double-charges.
4. Failure states are explicit and actionable, never generic.

### FR-PAY-03 · Entitlement Evaluation `M2`
**Purpose** Determine what a user may access, at every access point.
**Actors** System
**Inputs** Subscription state, plan, quotas, feature request
**Outputs** Permit or deny with reason
**Rules**
1. Evaluated server-side at the point of access (INV-15).
2. Correctness content is always permitted regardless of entitlement (INV-08).
3. Denial always states what is required and what it provides.
4. Entitlement loss never destroys data — it restricts access to it.

### FR-PAY-04 · Subscription Lifecycle `M2`
**Purpose** Manage state from purchase to expiry.
**Actors** Student, System, Support
**Inputs** Renewal events, cancellation, upgrade, downgrade, expiry
**Outputs** Updated subscription state and entitlements; notifications
**Rules**
1. States: `active`, `past_due`, `grace`, `cancelled`, `expired`.
2. Cancellation retains access through the paid period.
3. Upgrades apply immediately with proration; downgrades apply at renewal.
4. Renewal is preceded by advance notification with a clear cancellation path.

### FR-PAY-05 · Payment Failure & Recovery `M2`
**Purpose** Retain users through recoverable failures.
**Actors** System, Student
**Inputs** Failed payment event, retry schedule
**Outputs** Retry attempts, grace period, notifications, eventual downgrade
**Rules**
1. A defined grace period precedes any loss of access.
2. Retries follow a bounded schedule with notification at each stage.
3. Access degrades to free tier on grace expiry; data is never deleted.
4. Payment failure never interrupts an in-progress mock attempt.

### FR-PAY-06 · Mandate Management `M2`
**Purpose** Handle recurring UPI and card mandates correctly.
**Actors** Student, System
**Inputs** Mandate creation, modification, revocation, pre-debit notification
**Outputs** Mandate state; scheduled debits
**Rules**
1. Pre-debit notification is issued per regulatory requirement before each debit.
2. Mandate revocation is self-service and takes effect without Support intervention.
3. A price change requires a fresh mandate; existing mandates cannot be silently re-priced.

### FR-PAY-07 · Refunds & Credits `M2`
**Purpose** Resolve commercial disputes.
**Actors** Support, Content Ops, System
**Inputs** Refund request, reason, amount, approval
**Outputs** Refund transaction, entitlement adjustment, credit note, audit record
**Rules**
1. Governed by a published refund policy (PRD §15 M11).
2. Requires approval above a threshold amount, with justification.
3. Every refund is audited with actor and reason.
4. Refund adjusts entitlement per policy; it does not delete academic history.

### FR-PAY-08 · Invoicing & Tax `M2`
**Purpose** Meet statutory financial obligations.
**Actors** System, Student
**Inputs** Transaction, tax parameters, customer details
**Outputs** Compliant invoice or credit note
**Rules**
1. Invoices comply with applicable GST requirements.
2. Issued automatically on every successful transaction and retrievable indefinitely by the student.
3. Invoices are immutable; corrections are issued as credit notes.

### FR-PAY-09 · Promotions & Discounts `M2`
**Purpose** Support acquisition and seasonal pricing.
**Actors** Content Ops, Platform Admin, System
**Inputs** Promo definition, eligibility, validity, usage caps
**Outputs** Applied discount; usage tracking
**Rules**
1. Eligibility and caps are enforced server-side.
2. Codes are single-use per account unless explicitly defined otherwise.
3. Promotions cannot be stacked unless explicitly permitted.
4. Every promotion has a mandatory expiry.

### FR-PAY-10 · Paywall Presentation `M2`
**Purpose** Convert at the moment of demonstrated value.
**Actors** System, Student
**Inputs** Blocked action, entitlement gap, usage context
**Outputs** Contextual upgrade prompt
**Rules**
1. Presented at the point of demonstrated value, never during onboarding (PRD §5 J6).
2. States precisely what is gated and what upgrading unlocks.
3. Never interrupts an in-progress practice or mock session.
4. Frequency-capped per user to avoid harassment.

---

## 11. AI Features (FR-AI)

### FR-AI-01 · Item Generation `M0`
**Purpose** Scale content production without scaling cost linearly.
**Actors** Content Ops, AI Generation Agent
**Inputs** Target concept, difficulty, item type, exemplar items, taxonomy context, syllabus scope, quantity
**Outputs** Candidate items with solutions, provenance, and confidence
**Rules**
1. Candidates enter the identical review workflow as human content (INV-01, FR-QM-03).
2. Every candidate records model identity, prompt version, generation run, and confidence (FR-QM-05).
3. Generation is grounded in taxonomy and exemplars; ungrounded free generation is not permitted.
4. Candidates failing automated pre-checks (FR-AI-02) never reach a reviewer.
5. Generation runs are budget-bounded (FR-AI-09).

### FR-AI-02 · Automated Pre-Checks `M0`
**Purpose** Protect reviewer time — the scarcest resource in the pipeline.
**Actors** System, AI Generation Agent
**Inputs** Candidate item and solution
**Outputs** Pass/fail per check with rationale; overall disposition
**Rules**
1. Checks: answer verification (independent re-derivation), syllabus-scope conformance, duplicate detection, difficulty plausibility, renderability, distractor validity, factual consistency between item and solution.
2. Answer verification uses a path independent of generation; agreement is required.
3. Any failed check routes the candidate to rejection or repair, never to a reviewer.
4. Pre-check results are visible to the reviewer for accepted candidates.
5. Pre-checks are advisory for human-authored content and blocking for AI-generated content.

### FR-AI-03 · Solution Generation `M0`
**Purpose** Produce explanatory depth at scale.
**Actors** Content Ops, Author, AI Generation Agent
**Inputs** Item, correct answer, target depth, style guidance
**Outputs** Candidate step-by-step solution, alternate approaches, distractor analysis
**Rules**
1. Subject to identical review requirements (INV-01).
2. The final answer in the solution must match the item's key; mismatch is an automatic rejection.
3. May be used to augment human-authored items; provenance records the AI contribution as `AI-assisted`.

### FR-AI-04 · Distractor Analysis `M1`
**Purpose** Explain why the wrong answer was attractive — the highest-value explanatory content.
**Actors** AI Generation Agent, Reviewer, System
**Inputs** Item, options, correct answer, empirical selection data
**Outputs** Per-distractor misconception explanation
**Rules**
1. Requires human review before student visibility (INV-01).
2. Empirical selection data (FR-QM-09) informs and prioritizes the analysis once available.
3. Surfaced to the student contextually based on their actual selection (FR-PRA-04).

### FR-AI-05 · Difficulty Estimation `M1`
**Purpose** Provide a usable difficulty signal before empirical data exists.
**Actors** AI Generation Agent, System
**Inputs** Item content, concept, solution complexity, comparable items
**Outputs** Estimated difficulty with confidence
**Rules**
1. Explicitly marked as an estimate.
2. Superseded by empirical statistics once the exposure threshold is met (FR-QM-09).
3. Systematic divergence between estimate and empirical value feeds model evaluation (FR-AI-10).

### FR-AI-06 · Semantic Representation `M1`
**Purpose** Enable meaning-based retrieval and similarity.
**Actors** System
**Inputs** Item, stimulus, solution, concept content
**Outputs** Semantic representations supporting FR-SRCH-03 and FR-SRCH-04
**Rules**
1. Regenerated on every content version change.
2. Model version is recorded; a model change requires full regeneration before search behavior changes.
3. Never exposed directly to end users.

### FR-AI-07 · AI Tutor `H1` *(thin M2 pilot)*
**Purpose** Provide conversational remediation grounded in verified content.
**Actors** Student, AI Tutor Agent
**Inputs** Student question, item context, attempt history, concept state
**Outputs** Scaffolded explanation, follow-up questions, concept links
**Rules**
1. Grounded strictly in published, reviewed content — no ungrounded assertions about exam content.
2. Scaffolds toward understanding; does not simply supply answers (PRD §13 R16).
3. Every response carries an AI-generated label.
4. Cannot author, publish, or alter content of any kind.
5. Refuses out-of-scope requests and escalates suspected content defects to FR-QM-08.
6. Conversations are retained for quality evaluation under the stated privacy policy.

### FR-AI-08 · AI Provenance Record `M0`
**Purpose** Make every AI contribution attributable and auditable.
**Actors** System
**Inputs** Generation event metadata
**Outputs** Immutable provenance record
**Rules**
1. Records model identity and version, prompt version, run identity, inputs, confidence, and pre-check results.
2. Immutable and permanently retained (INV-02).
3. Enables retrospective identification of all content produced by a given model or prompt version — a prerequisite for recall if a defect is found.

### FR-AI-09 · Cost Governance `M1`
**Purpose** Keep AI economically viable at low ARPU.
**Actors** Content Ops, Platform Admin, System
**Inputs** Budgets per run, per feature, per user, per period; consumption
**Outputs** Consumption tracking; enforcement; alerts
**Rules**
1. Budgets are enforced, not merely monitored; exhaustion halts non-essential AI work.
2. Per-user limits prevent individual cost concentration.
3. Cost per published item and per active user is tracked against the PRD §7 targets.
4. Budget exhaustion degrades gracefully (FR-AI-12) and never blocks core learning features.

### FR-AI-10 · Quality Evaluation Harness `M0`
**Purpose** Prevent silent quality regression from model or prompt changes.
**Actors** Content Ops, System
**Inputs** Golden evaluation set, candidate model or prompt version, reviewer decisions, defect data
**Outputs** Quality scores, regression report, promotion decision
**Rules**
1. No prompt or model version reaches production without passing the evaluation suite.
2. Reviewer rejection reasons and downstream defect reports feed the evaluation set continuously.
3. Acceptance rate and defect rate are tracked per model and prompt version (PRD §7).
4. Regression blocks promotion; it does not merely warn.

### FR-AI-11 · Model & Prompt Version Management `M0`
**Purpose** Make AI behavior reproducible and reversible.
**Actors** Content Ops, Platform Admin
**Inputs** Model and prompt version definitions, activation, rollback
**Outputs** Active version set; version history
**Rules**
1. Versions are pinned explicitly; automatic model upgrades are not permitted.
2. Every generated artifact records the exact versions used.
3. Rollback to any prior version is always possible.
4. Version changes are audited and gated by FR-AI-10.

### FR-AI-12 · Degradation & Fallback `M1`
**Purpose** Ensure AI unavailability never breaks the product.
**Actors** System
**Inputs** Provider availability, budget state, latency
**Outputs** Degraded behavior; user-facing status
**Rules**
1. No core student workflow — practice, mock, scoring, solutions, analytics — may depend on live AI availability.
2. AI features degrade with explicit user-facing messaging, never silent failure.
3. Generation queues and retries; it does not lose work.
4. Published content is never affected by AI unavailability.

---

## 12. Notifications (FR-NOT)

### FR-NOT-01 · Notification Catalog & Triggers `M2`
**Purpose** Define every message the platform may send.
**Actors** System, Platform Admin
**Inputs** Trigger events, templates, audience rules
**Outputs** Notification instances
**Rules**
1. Categories: transactional, academic, engagement, promotional, system.
2. Every notification type is registered in the catalog; ad-hoc sends are not permitted.
3. Templates are versioned and localizable.

### FR-NOT-02 · Delivery & Channel Selection `M2`
**Purpose** Reach the user appropriately.
**Actors** System
**Inputs** Notification, user preferences, channel availability, consent
**Outputs** Delivered notification; delivery status
**Rules**
1. Preferences (FR-STU-15) are honoured except for transactional notifications.
2. Channel selection respects consent state per channel.
3. Delivery failure on one channel may fall back only within categories the user has permitted.
4. Delivery status is tracked for transactional messages.

### FR-NOT-03 · Frequency & Timing Controls `M2`
**Purpose** Prevent notification harm in a minor-heavy user base.
**Actors** System
**Inputs** Send history, quiet hours, caps
**Outputs** Sent, deferred, or suppressed notification
**Rules**
1. Per-category daily and weekly caps apply.
2. Quiet hours are honoured in the user's timezone; transactional and security messages are exempt.
3. Notifications are never sent during an in-progress mock attempt.
4. Minors receive tighter default caps and narrower quiet-hour windows.

### FR-NOT-04 · Transactional Notifications `M2`
**Purpose** Deliver messages the user must receive.
**Actors** System
**Inputs** Security, payment, result, and account events
**Outputs** Guaranteed-delivery notification
**Rules**
1. Cannot be disabled by preference.
2. Includes: credential change, new-device login, payment success and failure, renewal reminder, result publication, re-scoring, challenge outcome, account action.
3. Sent to all verified channels for security-critical events.

### FR-NOT-05 · Consent & Compliance `M2`
**Purpose** Meet consent obligations for marketing contact.
**Actors** Student, Parent/Guardian, System
**Inputs** Consent state per channel and category
**Outputs** Consent record honoured at send time
**Rules**
1. Promotional contact requires explicit opt-in; it is never granted by default.
2. Minors' promotional notifications require guardian consent (INV-10).
3. Every promotional message carries a one-action opt-out.
4. Consent state is versioned and auditable.

### FR-NOT-06 · In-App Inbox `M2`
**Purpose** Provide a durable record independent of push delivery.
**Actors** Student
**Inputs** Delivered notifications
**Outputs** Readable, filterable message history
**Rules**
1. All notifications appear in the inbox regardless of external channel outcome.
2. Read state syncs across devices.
3. Retained for a defined period; transactional records are retained longer.

---

## 13. Search & Discovery (FR-SRCH)

### FR-SRCH-01 · Structured Filtering `M1`
**Purpose** Retrieve content by known attributes.
**Actors** Student, Author, Reviewer, Content Ops
**Inputs** Subject, chapter, topic, concept, difficulty, item type, source, year, state, tags
**Outputs** Filtered, paginated result set
**Rules**
1. Results are scoped by role and entitlement (INV-15).
2. Students see only published, non-retired content.
3. Filters compose; the active filter set is always visible and individually removable.

### FR-SRCH-02 · Full-Text Search `M1`
**Purpose** Find content by literal wording.
**Actors** All content-facing roles
**Inputs** Query text, filters
**Outputs** Ranked results with matched-term highlighting
**Rules**
1. Searches item stems, stimuli, solutions, and concept names within permitted scope.
2. Mathematical notation is searchable in its structured form, not only as rendered output.
3. Result ranking is explainable and stable for identical queries.

### FR-SRCH-03 · Semantic Search `M2`
**Purpose** Find content by meaning when wording is unknown.
**Actors** Student, Author, Reviewer, Content Ops
**Inputs** Natural-language query, filters
**Outputs** Ranked results by semantic relevance
**Rules**
1. Operates within the same permission and entitlement scope as all other search.
2. Combines with structured filters rather than replacing them.
3. Returns nothing rather than poor matches below a relevance threshold.

### FR-SRCH-04 · Similar Item Retrieval `M1`
**Purpose** Support "more like this" for practice and duplicate detection.
**Actors** Student, Author, Reviewer, System
**Inputs** Reference item
**Outputs** Ranked similar items with similarity rationale
**Rules**
1. Powers student "practise similar", author reuse, and reviewer duplicate checking.
2. For students, excludes recently seen items and respects entitlement.
3. Similarity considers concept, structure, and difficulty — not surface wording alone.

### FR-SRCH-05 · Scoped Access Enforcement `M0`
**Purpose** Ensure search never becomes a permission bypass.
**Actors** System
**Inputs** Principal, role, entitlement, query
**Outputs** Permitted result set
**Rules**
1. Draft, in-review, suspended, and retired content is never returned to students under any query.
2. Authors see their own drafts; reviewers see assigned queue content.
3. Result counts and metadata never leak the existence of unpermitted content.
4. Answer keys and solutions are never returned in search results for an unattempted item during an active mock.

### FR-SRCH-06 · Search History & Saved Queries `M2`
**Purpose** Reduce repeated effort for heavy users.
**Actors** Author, Reviewer, Content Ops, Student
**Inputs** Executed queries, save action
**Outputs** Recent and saved queries
**Rules**
1. Saved queries are private to the user.
2. Saved queries re-execute against current content; results are not frozen.

---

## 14. Moderation & Trust (FR-MOD)

### FR-MOD-01 · Report Intake `M1`
**Purpose** Provide a single path for surfacing problems.
**Actors** Student, Author, Reviewer, System
**Inputs** Target (content, user, conversation), category, description, evidence
**Outputs** Moderation record in triage
**Rules**
1. Categories: content defect, offensive content, abuse or harassment, integrity violation, spam, other.
2. Content defects route to FR-QM-08; conduct issues route to moderation triage.
3. Reporters are rate-limited; reporter identity is never disclosed to the reported party.

### FR-MOD-02 · Triage Queue `M2`
**Purpose** Resolve reports predictably.
**Actors** Content Ops, Support, Platform Admin
**Inputs** Moderation records, severity, history
**Outputs** Prioritized queue; decisions
**Rules**
1. Severity determines target resolution time; safety-related reports take absolute priority.
2. Reports against the same target are grouped.
3. Every decision records a rationale (INV-02).

### FR-MOD-03 · Content Action `M1`
**Purpose** Remove harmful or defective content quickly.
**Actors** Content Ops, Platform Admin
**Inputs** Content reference, action, reason
**Outputs** Suspended or retired content; audit record; notifications
**Rules**
1. Suspension is immediate and reversible; it removes student visibility while preserving history.
2. Suspending an item in an active mock form does not invalidate in-progress attempts; the item is handled at scoring per the profile's dropped-item rules.
3. Author is notified with the reason and may appeal (FR-MOD-06).

### FR-MOD-04 · User Sanctions `M2`
**Purpose** Address conduct violations proportionately.
**Actors** Platform Admin, Content Ops
**Inputs** User, violation, evidence, sanction level
**Outputs** Warning, restriction, suspension, or termination; notification; audit record
**Rules**
1. Sanctions escalate; termination is never a first response except for severe safety violations.
2. Requires documented evidence and step-up authentication.
3. The user is notified with the reason and the appeal path.
4. Sanctions restrict access; they never delete the user's academic history.
5. Paid subscriptions under sanction are handled per the published policy.

### FR-MOD-05 · Abuse Signal Detection `M2`
**Purpose** Detect credential sharing, scraping, and integrity violations.
**Actors** System
**Inputs** Access patterns, session behavior, request volume, attempt anomalies
**Outputs** Signals routed to moderation triage
**Rules**
1. Signals are advisory inputs to human review; they never trigger automatic sanctions.
2. Detected patterns include improbable concurrent use, systematic content extraction, and attempt-timing anomalies.
3. Detection uses behavioral signals only — never device fingerprinting beyond what is disclosed, and never biometrics.

### FR-MOD-06 · Appeals `M2`
**Purpose** Provide due process on moderation outcomes.
**Actors** Student, Author, Content Ops, Platform Admin
**Inputs** Appeal with justification
**Outputs** Review outcome; reversal or confirmation
**Rules**
1. Every sanction and content action is appealable within a defined window.
2. Appeals are reviewed by someone other than the original decision-maker.
3. Outcomes are communicated with reasoning.

### FR-MOD-07 · Academic Integrity Policy Enforcement `M2`
**Purpose** Protect the meaning of results.
**Actors** System, Content Ops
**Inputs** Integrity signals, attempt annotations
**Outputs** Attempt annotation, statistical exclusion, escalation
**Rules**
1. Anomalous attempts may be excluded from cohort statistics without invalidating the student's own result.
2. Invalidating a result requires human review and a communicated reason.
3. Enforcement uses no surveillance mechanisms (INV — see PRD §12).

---

## 15. Reporting (FR-RPT)

### FR-RPT-01 · Student Progress Report `M2`
**Purpose** Give students and parents a shareable summary.
**Actors** Student, System
**Inputs** Date range, scope
**Outputs** Formatted report: coverage, mastery gains, mock trajectory, focus areas
**Rules**
1. Generated on demand or on a schedule chosen by the student.
2. Shareable via an expiring, authenticated link the student controls and can revoke.
3. Contains no cohort-identifying data.

### FR-RPT-02 · Content Operations Report `M1`
**Purpose** Manage the content pipeline with evidence.
**Actors** Content Ops
**Inputs** Date range, subject scope
**Outputs** Inventory by state, coverage by concept, throughput, defect rates, quality distribution
**Rules**
1. Coverage counts only published, non-retired content.
2. Segments human-authored versus AI-generated across every metric.

### FR-RPT-03 · Review Throughput Report `M1`
**Purpose** Manage the pipeline's most likely bottleneck (PRD §13 R12).
**Actors** Content Ops
**Inputs** Review decisions, queue state
**Outputs** Per-reviewer throughput, queue depth and ageing, decision distribution, first-pass acceptance
**Rules**
1. Used for capacity planning, not for punitive individual evaluation.
2. Queue ageing beyond threshold is escalated (FR-ADM-05).

### FR-RPT-04 · Business Report `M2`
**Purpose** Track commercial health.
**Actors** Platform Admin
**Inputs** Subscription, payment, and engagement data
**Outputs** Conversion, ARPU, churn, retention cohorts, revenue, refunds
**Rules**
1. Aggregate only; no individual financial detail beyond what Support requires for a specific ticket.
2. Access is restricted and audited.

### FR-RPT-05 · AI Quality & Cost Report `M1`
**Purpose** Keep the AI pipeline honest and affordable.
**Actors** Content Ops, Platform Admin
**Inputs** Generation runs, review outcomes, defect data, cost consumption
**Outputs** Acceptance rate, defect rate, cost per published item, cost per active user, per-version comparison
**Rules**
1. Segmented by model version and prompt version.
2. Tracked against PRD §7 targets with alerting on breach.

### FR-RPT-06 · Compliance & Audit Report `M2`
**Purpose** Demonstrate regulatory compliance on demand.
**Actors** Platform Admin
**Inputs** Consent records, deletion requests, access logs, retention state
**Outputs** Consent coverage, request fulfilment timeliness, retention conformance, privileged-access summary
**Rules**
1. Generated on demand for audit or regulatory response.
2. Report generation is itself audited.

### FR-RPT-07 · Scheduled Delivery `M2`
**Purpose** Push reports to those who need them without manual effort.
**Actors** Content Ops, Platform Admin, Student
**Inputs** Report, schedule, recipients, format
**Outputs** Delivered report
**Rules**
1. Recipients must hold the permission required to view the report content.
2. Delivery is via authenticated channels only.
3. Schedules are individually pausable.

### FR-RPT-08 · Data Export `M2`
**Purpose** Support analysis outside the platform.
**Actors** Content Ops, Platform Admin
**Inputs** Data scope, format, date range
**Outputs** Machine-readable export
**Rules**
1. Exports containing personal data require step-up authentication and are audited.
2. Exports are de-identified unless personal data is explicitly justified and approved.
3. Export volume and frequency are rate-limited.

---

## 16. Traceability

| PRD Feature Category (§10) | FRS Sections |
|---|---|
| Content Authoring & Management | FR-TCH, FR-QM-01/02/06/10/14 |
| Content Governance | FR-QM-03/04/05/07/08/12, FR-ADM-05/06 |
| Taxonomy & Curriculum | FR-ADM-02, FR-QM-13 |
| Assessment Delivery | FR-MOCK, FR-ADM-04 |
| Scoring & Psychometrics | FR-MOCK-07/10, FR-ADM-03/08, FR-QM-09 |
| Learning & Practice | FR-PRA, FR-STU-05/06/07 |
| AI Services | FR-AI |
| Search & Discovery | FR-SRCH |
| Analytics & Insight | FR-ANA, FR-RPT |
| Identity, Access & Billing | FR-AUTH, FR-PAY |
| Engagement | FR-NOT, FR-STU-13 |
| Platform & Operations | FR-ADM, FR-MOD, FR-RPT |

---
