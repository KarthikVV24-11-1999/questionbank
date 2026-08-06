# Domain Model
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft for ratification
**Traces to:** [PRD.md](PRD.md) · [FRS.md](FRS.md) §1 invariants · [NFR.md](NFR.md) §11
**Phase:** 1 — Domain Model & Bounded Contexts

> No storage, schema, index, or persistence decisions appear here. Aggregate size is a *consistency* statement, not a loading strategy — loading is Phase 3.

---

## 0. Conventions

| Notation | Meaning |
|---|---|
| **⬢ AR** | Aggregate Root — transactional consistency boundary. Referenced from outside **by identity only**. |
| **◆ E** | Entity — has identity, lives inside an aggregate, never referenced externally. |
| **○ VO** | Value Object — immutable, no identity, compared by value. |
| **▷ Event** | Domain event published across a context boundary. |

**Rules applied throughout**
- Aggregates reference other aggregates by ID, never by object reference.
- One aggregate mutated per transaction. Cross-aggregate consistency is achieved by events and is explicitly acknowledged as eventual.
- Every mutation carries a `PrincipalRef` — human **or machine**.

---

## 1. Context Map

| # | Bounded Context | Owns | Core question it answers |
|---|---|---|---|
| 1 | **Identity & Access** | Who a principal is, what they may do | *Who is acting?* |
| 2 | **Curriculum** | Taxonomy, concepts, exams, exam profiles | *What is being examined, under what rules?* |
| 3 | **Content** | Items, stimuli, solutions, media, governance | *What is the question, and is it trustworthy?* |
| 4 | **Assessment** | Forms, attempts, response logs | *What did the learner actually do?* |
| 5 | **Scoring** | Score records, re-scoring | *What does that mean in marks?* |
| 6 | **Psychometrics** | Item statistics, exposure, calibration | *How good is this item, empirically?* |
| 7 | **Learning** | Learner profile, concept mastery, remediation | *What does this learner know, and what next?* |
| 8 | **AI Content** | Generation, model/prompt versions, evaluation | *What did the machine propose, and is it good?* |
| 9 | **Commerce** | Plans, subscriptions, entitlements, payments | *What may this learner access?* |
| 10 | **Engagement** | Notifications, preferences, delivery | *What should we tell them, and when?* |
| 11 | **Trust & Safety** | Moderation, sanctions, abuse signals | *Is this actor or content acceptable?* |

### 1.1 Context Relationships

```
                    ┌──────────────────┐
                    │ Identity & Access│  (Shared Kernel: PrincipalRef)
                    └────────┬─────────┘
                             │ referenced by all
   ┌─────────────┐   U/S     ▼
   │ Curriculum  ├──────────► Content ◄──────────┤ AI Content
   │ (taxonomy,  │           (Item,               (proposes only,
   │  profiles)  │            Solution)            never writes) ── ACL
   └──────┬──────┘               │
          │ U/S                  │ U/S
          ▼                      ▼
   ┌──────────────────────────────────────┐
   │           Assessment                  │  Form ▸ Attempt ▸ ResponseLog
   │  (pins ProfileVersion + ItemVersions) │
   └──────┬────────────────────────┬───────┘
          │ ▷AttemptSubmitted      │ ▷AttemptSubmitted
          ▼                        ▼
   ┌─────────────┐          ┌───────────────┐
   │  Scoring    │          │ Psychometrics │
   │ ScoreRecord │          │ ItemStatistics│
   └──────┬──────┘          └───────┬───────┘
          │ ▷ScorePublished         │ (feeds difficulty back to Content)
          ▼                         ▼
   ┌──────────────────────────────────────┐
   │             Learning                  │  ConceptMap ▸ Mastery ▸ Remediation
   └──────────────────────────────────────┘
          ▲                         ▲
          │ entitlement checks      │ triggers
   ┌──────┴──────┐          ┌───────┴───────┐        ┌──────────────┐
   │  Commerce   │          │  Engagement   │        │Trust & Safety│
   └─────────────┘          └───────────────┘        └──────────────┘
```

| Relationship | Pattern |
|---|---|
| Curriculum → Content | Upstream/Downstream. Content conforms to taxonomy and profile contracts. |
| Curriculum → Assessment | Upstream. Assessment pins an immutable `ExamProfileVersion`. |
| Content → Assessment | Upstream. Assessment pins immutable `ItemVersion` / `StimulusVersion` IDs. |
| Assessment → Scoring | Upstream. Scoring interprets; it never mutates the attempt. |
| Assessment → Psychometrics | Upstream, eventually consistent, derived. |
| **AI Content → Content** | **Anti-Corruption Layer.** AI emits `GenerationCandidate`; Content translates accepted candidates into drafts. AI never writes Content aggregates. |
| Psychometrics → Content | Downstream feedback: empirical difficulty supersedes authored estimate. |
| Commerce → all | Published Language. `EntitlementSet` is consumed, never owned, by other contexts. |
| Identity → all | Shared Kernel: `PrincipalRef`, `UserId`, `RoleSet`. The only shared kernel permitted. |

---

## 2. Key Modeling Decisions

These are the load-bearing choices. Each exists to make a specific invariant or NFR structurally guaranteed rather than procedurally enforced.

**D1 — Stable identity is separated from versioned manifestation.**
Applied uniformly to Concept, Exam, Item, Stimulus, Solution, Plan, Prompt, Model. The identity aggregate is tiny, permanent, and referenceable forever; versions are immutable snapshots hanging off it. This single pattern makes INV-03, INV-04, taxonomy migration (FR-QM-13), and score reproducibility all fall out for free.

**D2 — `Attempt` is mode-parameterized, not duplicated.**
Mock, practice, and diagnostic are one aggregate distinguished by a pinned `DeliveryPolicy`. Alternative designs duplicate response capture, timing, and scoring three times and guarantee divergence. Mocks pin a `Form`; practice grows its slot list dynamically. Scoring, analytics, and psychometrics then work uniformly across all three.

**D3 — `Attempt` (what happened) is separated from `ScoreRecord` (what it means).**
The attempt is an immutable factual record. A score is an *interpretation* of it under a rule set version. Re-scoring produces a new `ScoreRecord`; nothing is ever mutated. INV-11 (dual-result retention) becomes structurally impossible to violate rather than a feature someone must remember to implement.

**D4 — Responses are an append-only event log; "the answer" is a projection.**
`ResponseEvent` records every selection, change, clear, and flag with timing. The current answer per slot is derived. This is what makes REL-01 (zero loss), REL-06 (conflict resolution in favour of the complete local log), and answer-change analytics (FR-ANA-03) all the same mechanism.

**D5 — `Solution` is its own aggregate, not part of `Item`.**
Accepts one cross-aggregate invariant ("no publication without a solution", enforced as a precondition at the publication transition) in exchange for correcting an explanation without touching the item or invalidating a single historical attempt. The trade is deliberate and favourable.

**D6 — `MarkingRuleSet` is an immutable Value Object owned by Curriculum and pinned by `Attempt`.**
Marking is data, never code. This is the mechanism behind EXT-03 (new marking rules with zero code change), INV-04 (attempts score under the rules in force), and JEE Advanced partial-credit absorption without touching the core.

**D7 — `ConceptMap` is one aggregate per learner, not one per learner-concept pair.**
The learner's full concept state is what changes together after an attempt, so it is the correct consistency boundary. It is naturally bounded (~2,000 concepts per exam).

**D8 — AI proposes; it never writes.**
`GenerationCandidate` lives in the AI context. Acceptance translates it across an ACL into a Content draft. INV-01 is therefore enforced by the context boundary itself — there is no code path from a model to a published item.

**D9 — `Entitlement` is a derived read model, not a stored aggregate.**
Computed from `Subscription` + `PlanVersion` at evaluation time. Only *consumption* (`QuotaLedger`) is stateful. This prevents entitlement drift, the classic source of "paid user denied access" defects (REL-11).

**D10 — `PrincipalRef` treats humans and machines identically.**
A Value Object of `{ kind: human | ai_agent | system, id, roleContext }`. Every mutation and audit record carries one. AI attribution is not a special case bolted on — it is the same mechanism as human attribution.

---

## 3. Context 1 — Identity & Access

### ⬢ User · AR
**Purpose** The stable identity of a human principal.
**Responsibilities** Own credentials and contact channels; enforce verification state; hold role assignments; enforce that a role change is authorized and audited; expose `PrincipalRef`.
**Relationships** Referenced by every context via `UserId`. Owns `Credential`, `ContactChannel`, `RoleAssignment`. Referenced by `Consent`, `Session`, `LearnerProfile`, `Subscription`.
**Key attributes** `userId` · `displayName` · `dateOfBirth` (immutable post-verification) · `accountState` (unverified / active / restricted / suspended / deactivated / deleted) · `roleAssignments` · `isMinor` (derived from DOB + jurisdiction threshold)

- ◆ **Credential** — secret material reference, algorithm/work factor, rotation timestamp.
- ◆ **ContactChannel** — `{ type: email | mobile, value, verificationState, isPrimary }`.
- ◆ **RoleAssignment** — `{ role, scope (subject / org / global), grantedBy, grantedAt, justification }`.
- ○ **PrincipalRef** *(shared kernel)* — `{ kind: human | ai_agent | system, id, roleContext }`.

### ⬢ Consent · AR
**Purpose** Prove, for a specific purpose, that permission was given — and when, by whom, and under which policy version.
**Responsibilities** Maintain a versioned, append-only grant history per purpose; record guardian attestation for minors; enforce that revocation never erases history.
**Relationships** References `UserId`; guardian consent references a `GuardianContact`. Consumed by Engagement, Learning, Analytics.
**Key attributes** `consentId` · `userId` · `purpose` (terms / privacy / promotional / analytics / ai-processing) · `grants[]` (each: state, policyVersion, grantedAt, grantedBy, channel, evidence) · `guardianAttestation?`

### ⬢ Session · AR
**Purpose** A bounded, revocable authenticated context.
**Responsibilities** Track device context and lifetime; support individual and bulk revocation; never terminate an in-progress mock attempt.
**Relationships** References `UserId`. Read by Assessment for device continuity.
**Key attributes** `sessionId` · `userId` · `deviceContext` · `issuedAt` · `lastActiveAt` · `absoluteExpiry` · `revocation?`

### ⬢ AuditRecord · AR *(platform-wide, append-only)*
**Purpose** Make every consequential action reconstructable.
**Responsibilities** Immutability — no role may edit or delete. Record the principal, action, target aggregate and version, and justification where required.
**Relationships** References any aggregate by `{ contextName, aggregateType, aggregateId, version }`.
**Key attributes** `auditId` · `principal: PrincipalRef` · `action` · `target` · `occurredAt` · `justification?` · `beforeRef?` / `afterRef?`

---

## 4. Context 2 — Curriculum

### ⬢ ConceptIdentity · AR
**Purpose** A concept's permanent identity, independent of any syllabus version. *(D1)*
**Responsibilities** Survive syllabus revisions, splits, merges, and renames so that historical tags and mastery state remain interpretable forever.
**Relationships** Referenced by `ConceptNode` (placement), `TaxonomyTag` (Content), `ConceptState` (Learning), `ItemStatistics`.
**Key attributes** `conceptIdentityId` · `canonicalName` · `subjectDomain` · `createdIn` (taxonomy version) · `supersededBy?`

### ⬢ TaxonomyVersion · AR
**Purpose** One immutable, internally consistent snapshot of a syllabus hierarchy.
**Responsibilities** Guarantee tree integrity and prerequisite acyclicity; become immutable on publication; refuse retirement of a concept still referenced by published content.
**Relationships** Owns `ConceptNode`, `PrerequisiteEdge`. References `ConceptIdentity`. Referenced by `ExamProfileVersion`, `TaxonomyTag`, `Attempt` (for interpretation of historical analytics).
**Key attributes** `taxonomyVersionId` · `academicYear` · `state` (draft / published / superseded) · `publishedAt` · `nodes` · `prerequisites`

- ◆ **ConceptNode** — `{ conceptIdentityId, parentNodeId?, displayName, examWeight, depth, estimatedTeachingHours }`.
- ◆ **PrerequisiteEdge** — `{ fromConceptIdentityId, toConceptIdentityId, strength }`. Forms the concept graph consumed by Learning.

### ⬢ TaxonomyMigration · AR
**Purpose** Make a syllabus revision a governed, previewable, reversible operation. *(FR-QM-13)*
**Responsibilities** Hold the mapping between two taxonomy versions; classify each change; produce the exception list requiring human disposition; refuse execution while unresolved exceptions remain.
**Relationships** References two `TaxonomyVersion`s. Emits ▷`TagsMigrated` consumed by Content.
**Key attributes** `migrationId` · `fromVersion` / `toVersion` · `mappings[]` (`{ kind: identity | rename | move | split | merge | removal, from[], to[], disposition }`) · `exceptions[]` · `state`

### ⬢ Exam · AR
**Purpose** The stable identity of an examination (e.g. JEE Main). *(D1)*
**Responsibilities** Own its profile version history; guarantee exactly one active version per academic year.
**Relationships** Owns `ExamProfileVersion` references. Referenced by `LearnerProfile`, `Form`, `Plan`.
**Key attributes** `examId` · `code` · `displayName` · `jurisdiction` · `conductingBody` · `activeProfileVersions[]`

### ⬢ ExamProfileVersion · AR
**Purpose** The complete declarative specification of how one exam behaves in one year. **This is the multi-exam plugin contract.**
**Responsibilities** Define structure, timing, navigation, permitted item types, and marking — entirely as data. Become immutable on publication. Refuse activation until golden-set validation passes.
**Relationships** Belongs to `Exam`. References a `TaxonomyVersion`. Pinned by `Form` and `Attempt` (INV-04).
**Key attributes** `profileVersionId` · `examId` · `academicYear` · `state` · `sections[]` · `timingPolicy` · `navigationPolicy` · `markingRuleSet` · `itemTypeAllowances[]` · `toleranceDefaults` · `goldenSetValidation`

- ◆ **SectionSpec** — `{ ordinal, name, subject, itemCount, itemTypeMix, maxMarks, sectionTiming? }`.
- ○ **TimingPolicy** — `{ totalDuration, sectionLocking: bool, warningThresholds[], autoSubmitOnExpiry }`. *(JEE/NEET: `sectionLocking = false`, single timer.)*
- ○ **NavigationPolicy** — `{ crossSectionNavigation, allowMarkForReview, allowAnswerChange, allowClearResponse }`.
- ○ **MarkingRuleSet** *(the keystone VO — D6)* — an ordered set of `MarkingRule`, each `{ appliesTo: itemType + condition, outcome: award | penalty | partial-credit table | bonus | drop, marks }`. Covers JEE Main (+4/−1), NEET (+4/−1, single-correct only), and JEE Advanced graded partial credit **without any structural change**.
- ○ **ToleranceDefault** — default `NumericAnswerSpec` parameters, overridable per item.

---

## 5. Context 3 — Content

### ⬢ Item · AR
**Purpose** A question: its identity, its version history, and its governed lifecycle. **The most consequential aggregate in the system.**
**Responsibilities** Enforce the lifecycle state machine (FR-QM-01); guarantee at most one published version at a time; guarantee published versions are immutable (INV-03); refuse publication without tags, provenance, licensing, reviewer signature, and a valid answer specification (INV-07); prohibit self-review (INV-12).
**Relationships** References `StimulusId` (0..1), `TaxonomyVersion`, `ConceptIdentity` (via tags), `MediaAsset`. Referenced by `Solution`, `FormItemSlot`, `ResponseEvent`, `ItemStatistics`, `ItemDefect`, `AnswerKeyChallenge`. Owns `ItemVersion`, `ReviewDecision`.
**Key attributes** `itemId` · `itemType` · `lifecycleState` (draft / in_review / changes_requested / approved / published / suspended / retired) · `currentPublishedVersionId?` · `versions[]` · `retirementReason?` · `replacedByItemId?`

- ◆ **ItemVersion** *(immutable once published)* — `{ versionId, stem: ContentBody, responseSpec, taxonomyTags[], difficultyEstimate, provenance, licensing, stimulusVersionRef?, localeVariants[], authoredBy: PrincipalRef, createdAt }`.
- ◆ **ReviewDecision** — `{ reviewer: PrincipalRef, decision (approve / approve_with_edits / request_changes / reject), reasonCategory, comments, preEditVersionId?, signedAt }`.
- ○ **ContentBody** — structured, renderer-agnostic markup carrying text, mathematical notation, chemical notation, and media references. **Never rendered markup, never an image of text.** Underpins INV-14 and ACC-02.
- ○ **ResponseSpecification** — polymorphic by item type:
  - `SingleCorrectSpec` — `{ options[], correctOptionId }`
  - `NumericSpec` — see §12.1
  - *(H1)* `MultiCorrectSpec`, `MatchingSpec` — added without changing `Item`
- ○ **TaxonomyTag** — `{ conceptIdentityId, taxonomyVersionId, weight, isPrimary }`.
- ○ **Provenance** — `{ sourceType (original / previous_year / licensed / ai_generated / ai_assisted), sourceExam?, sourceYear?, sourceSession?, authorRef?, modelVersionId?, promptVersionId?, generationRunId?, confidence? }`.
- ○ **LicensingStatus** — `{ status (owned / licensed / public_domain / unresolved), licenseRef?, attribution?, expiresAt? }`. **`unresolved` blocks publication unconditionally.**
- ○ **LocaleVariant** — `{ locale, stem, options[], translatedBy, reviewState }`. Modeled now, delivered in H1 (EXT-04).

### ⬢ Stimulus · AR
**Purpose** Shared context — passage, diagram, dataset, reaction scheme — referenced by many items. *(A `passage_text` column on the item is the category's canonical fatal error.)*
**Responsibilities** Version independently; refuse retirement while referenced by published items; pin prior versions for existing associations until explicitly migrated.
**Relationships** Referenced by `ItemVersion` and `FormItemSlot`. Owns `StimulusVersion`.
**Key attributes** `stimulusId` · `stimulusType` · `lifecycleState` · `currentPublishedVersionId?` · `versions[]` · `referencingItemCount` *(derived)*

### ⬢ Solution · AR
**Purpose** The explanatory content — the product's actual value. *(D5)*
**Responsibilities** Version independently of the item; guarantee the stated final answer matches the item's key; hold distractor analysis and alternate approaches.
**Relationships** References `ItemId` + `ItemVersionId`. Owns `SolutionVersion`, `SolutionStep`, `DistractorAnalysis`, `AlternateApproach`.
**Key attributes** `solutionId` · `itemId` · `targetItemVersionId` · `lifecycleState` · `currentPublishedVersionId?`

- ◆ **SolutionStep** — `{ ordinal, body: ContentBody, conceptRefs[] }`.
- ◆ **DistractorAnalysis** — `{ optionId, misconception: ContentBody, empiricalSelectionRate? }`. Surfaced contextually based on the learner's actual selection (FR-PRA-04).
- ◆ **AlternateApproach** — `{ label, steps[], applicabilityNote }`.

### ⬢ MediaAsset · AR
**Purpose** Diagrams, figures, and images as governed, licensed, accessible content.
**Responsibilities** Enforce mandatory alt text (ACC-03); carry independent licensing; refuse deletion while referenced by published content.
**Relationships** Referenced by `ContentBody` in Item, Stimulus, Solution.
**Key attributes** `assetId` · `assetType` · `versions[]` · `altText` *(mandatory)* · `longDescription?` · `licensing` · `usageRefs[]` *(derived)*

### ⬢ ReviewAssignment · AR
**Purpose** Queue mechanics — the pipeline's most likely bottleneck (R12).
**Responsibilities** Route by subject scope; enforce the self-review prohibition at assignment time; escalate on ageing.
**Relationships** References `ItemId` / `SolutionId` and a reviewer `PrincipalRef`.
**Key attributes** `assignmentId` · `targetRef` · `assignedTo` · `priority` · `assignedAt` · `dueBy` · `state` · `escalationHistory[]`

### ⬢ ItemDefect · AR
**Purpose** Convert a defect report into tracked resolution.
**Responsibilities** Group reports on the same item; auto-suspend the item on a credible wrong-key report; guarantee every reporter receives an outcome.
**Relationships** References `ItemId` + `ItemVersionId`, reporter `PrincipalRef`. Emits ▷`ItemSuspended`, ▷`KeyDefectConfirmed` → Scoring.
**Key attributes** `defectId` · `itemVersionRef` · `category` · `severity` · `reports[]` · `triageState` · `resolution?` · `resolvedBy?`

### ⬢ AnswerKeyChallenge · AR
**Purpose** Due process on disputed correctness — the NEET-2024 requirement made structural.
**Responsibilities** Require a submitted attempt and written justification; group challenges per item; carry adjudication reasoning; trigger re-scoring on an upheld outcome.
**Relationships** References `ItemVersionId`, `AttemptId`, challenger `UserId`. Emits ▷`ChallengeUpheld` → Scoring (`RescoringOperation`).
**Key attributes** `challengeId` · `itemVersionRef` · `attemptRef` · `claimedAnswer` · `justification` · `state` (submitted / triaged / adjudicated) · `outcome?` (upheld_key_corrected / upheld_item_dropped / rejected) · `adjudicationReasoning` · `empiricalEvidence?`

---

## 6. Context 4 — Assessment

### ⬢ Form · AR
**Purpose** A fixed, pre-assembled examination paper.
**Responsibilities** Satisfy the profile blueprint exactly; pin specific item and stimulus versions; become immutable the moment any attempt exists against it.
**Relationships** References `ExamProfileVersionId`. Owns `FormSection`, `FormItemSlot`. Referenced by `Attempt`, `FormStatistics`. Emits ▷`FormAssembled` → Psychometrics (exposure).
**Key attributes** `formId` · `examProfileVersionId` · `formType` (mock / diagnostic) · `blueprintConformance` · `state` (draft / published / embargoed / active / closed) · `scheduleWindow?` · `resultEmbargo?` · `isImmutable` *(derived: any attempt exists)*

- ◆ **FormSection** — `{ ordinal, sectionSpecRef, slots[] }`.
- ◆ **FormItemSlot** — `{ slotId, ordinal, itemId, **itemVersionId**, stimulusVersionId?, marksAvailable }`. **Pinning the version here is what makes INV-04 real.**

### ⬢ Attempt · AR
**Purpose** The immutable factual record of what a learner did. *(D2, D3, D4)* **The highest-integrity aggregate in the system.**
**Responsibilities** Enforce append-only response capture (REL-01); guarantee idempotent submission (REL-02); anchor timing to server time (REL-09); pin every version needed to reproduce and score the attempt (INV-04); guarantee that no code path mutates or deletes a recorded response.
**Relationships** References `UserId`, `FormId?`, `ExamProfileVersionId`, `ItemVersionId` per slot. Owns `AttemptSlot`, `ResponseEvent`, `SectionState`. Emits ▷`AttemptStarted`, ▷`AttemptSubmitted` → Scoring, Psychometrics, Learning.
**Key attributes** `attemptId` · `userId` · `mode` (mock / practice / diagnostic) · `deliveryPolicy` *(pinned)* · `attemptPin` · `state` (in_progress / submitted / abandoned / expired) · `startedAt` · `serverAnchoredDeadline?` · `submission?`

- ○ **AttemptPin** *(the reproducibility guarantee)* — `{ examProfileVersionId?, markingRuleSetHash, taxonomyVersionId, itemVersionIds[], stimulusVersionIds[] }`.
- ○ **DeliveryPolicy** *(mode-parameterized — D2)* — `{ timing, navigation, feedbackMode (immediate / deferred), pausable, itemSelection (fixed / dynamic) }`. Derived from `ExamProfileVersion` for mocks; from `PracticePolicy` for practice.
- ◆ **AttemptSlot** — `{ slotId, ordinal, itemId, itemVersionId, presentedAt?, currentResponse *(projection)*, flagState, cumulativeTimeMs }`.
- ◆ **ResponseEvent** *(append-only — D4)* — `{ eventId, slotId, sequence, kind (select / change / clear / flag / unflag / visit / leave), payload, clientTimestamp, serverTimestamp, deviceRef }`.
- ◆ **SectionState** — `{ sectionOrdinal, enteredAt, timeSpentMs, lockState }`.
- ○ **SubmissionReceipt** — `{ idempotencyKey, submittedAt, submissionMode (manual / auto_expiry / recovered), clientEventCount, serverAcknowledgedAt }`. **The idempotency key is the mechanism behind REL-02.**

---

## 7. Context 5 — Scoring

### ⬢ ScoreRecord · AR
**Purpose** One *interpretation* of an attempt under one rule set version. *(D3)*
**Responsibilities** Be immutable once produced; be deterministic and reproducible from `AttemptPin` alone (REL-03); record which rule produced each item outcome so the score is explainable to the learner; never mutate — corrections create a successor record.
**Relationships** References `AttemptId`, `MarkingRuleSet` (by hash), `RescoringOperationId?`. Referenced by Learning, Psychometrics, Analytics.
**Key attributes** `scoreRecordId` · `attemptId` · `markingRuleSetHash` · `generation` (1 = original, n = nth re-score) · `isCurrent` · `supersedesScoreRecordId?` · `totalScore` · `sectionScores[]` · `itemOutcomes[]` · `computedAt` · `reasonForRescore?`

- ◆ **ItemOutcome** — `{ slotId, itemVersionId, responseSnapshot, correctness (correct / incorrect / unattempted / dropped / bonus), marksAwarded, **ruleApplied** (rule identifier + explanation) }`.
- ○ **SectionScore** / **TotalScore** — `{ raw, maxAvailable, attemptedCount, correctCount, incorrectCount, negativeMarksIncurred }`.

**Invariant:** exactly one `ScoreRecord` per attempt has `isCurrent = true`. All generations are retained permanently (INV-11).

### ⬢ RescoringOperation · AR
**Purpose** Make correcting historical results a governed, previewable, auditable operation.
**Responsibilities** Require a recorded reason and step-up authorization; produce a mandatory dry-run impact preview before execution; guarantee prior records survive; notify every affected learner.
**Relationships** Triggered by ▷`ChallengeUpheld` or ▷`KeyDefectConfirmed`. Produces new `ScoreRecord`s. Emits ▷`AttemptsRescored` → Engagement, Psychometrics.
**Key attributes** `operationId` · `trigger` · `scope` (item version / rule change / form) · `reason` · `dryRunResult` (affectedAttemptCount, scoreDelta distribution, rank movement) · `state` (drafted / previewed / approved / executing / completed) · `authorizedBy` · `executedAt?`

---

## 8. Context 6 — Psychometrics

*All aggregates here are derived and eventually consistent. All are recomputable from primary sources (BAK-06).*

### ⬢ ItemStatistics · AR
**Purpose** Replace opinion about item quality with evidence.
**Responsibilities** Compute only above a minimum exposure threshold; supersede the authored difficulty estimate; auto-flag negative or near-zero discrimination; flag a distractor disproportionately chosen by high performers as a probable key error.
**Relationships** References `ItemVersionId`. Emits ▷`ItemAnomalyDetected` → Content (`ItemDefect`), ▷`EmpiricalDifficultyAvailable` → Content.
**Key attributes** `itemVersionId` · `exposureCount` · `difficulty` (p-value) · `discrimination` · `distractorDistribution[]` · `medianTimeMs` · `anomalyFlags[]` · `computedAt` · `isAboveThreshold`

### ⬢ ExposureLedger · AR
**Purpose** Record every presentation of an item — required now for equating later (PRD §15 M5).
**Responsibilities** Append-only exposure accounting; support pool eligibility rules and exposure caps.
**Relationships** References `ItemVersionId`, `FormId?`, `AttemptId`.
**Key attributes** `itemVersionId` · `entries[]` (`{ attemptRef, formRef?, sessionRef?, presentedAt, mode }`) · `totalExposure` · `exposureByWindow`

### ⬢ FormStatistics · AR
**Purpose** Cohort-level distribution for a form — the basis of percentile and, later, equating.
**Responsibilities** Suppress output below a minimum cohort size (ACC/PRI: FR-ANA-06); recompute on re-scoring.
**Key attributes** `formId` · `cohortSize` · `scoreDistribution` · `percentileTable` · `sectionDistributions[]` · `recomputedAt`

### ⬢ CalibrationRun · AR *(H1)*
**Purpose** IRT parameter estimation and cross-form equating.
**Relationships** Consumes `ExposureLedger`, `ItemStatistics`, `ScoreRecord`. Produces calibrated parameters consumed by adaptive selection (FR-PRA-08) and predicted scoring (FR-ANA-08).
**Key attributes** `runId` · `model` (1PL / 2PL / 3PL) · `itemParameters[]` · `abilityEstimates[]` · `fitStatistics` · `state`

---

## 9. Context 7 — Learning

### ⬢ LearnerProfile · AR
**Purpose** Learning-specific configuration, distinct from identity.
**Responsibilities** Hold target exam and year, declared syllabus scope, and preferences; guarantee that changing target exam never resets history.
**Relationships** References `UserId`, `ExamId`, `TaxonomyVersionId`.
**Key attributes** `learnerProfileId` · `userId` · `targetExamId` · `targetYear` · `currentClass` · `declaredScope` (concept identity set) · `locale` · `timezone` · `accommodations?` (e.g. extended time — ACC-11)

### ⬢ ConceptMap · AR
**Purpose** What this learner knows, at concept granularity. *(D7)* **The product's core state and the north-star metric's source.**
**Responsibilities** Maintain per-concept state and confidence; require every state to be traceable to specific evidence; apply time decay; record a `MasteryGain` only on *verified* transition (§12.2); record regressions rather than silently deleting gains.
**Relationships** References `UserId`, `ConceptIdentityId`, `TaxonomyVersionId`. Consumes ▷`AttemptSubmitted` + ▷`ScorePublished`. Owns `ConceptState`, `MasteryTransition`.
**Key attributes** `conceptMapId` · `userId` · `taxonomyVersionId` · `conceptStates[]` · `lastRecomputedAt`

- ◆ **ConceptState** — `{ conceptIdentityId, state (unassessed / weak / developing / strong), confidence, evidenceCount, distinctItemCount, distinctSessionCount, lastEvidenceAt, difficultyBandDemonstrated, decayAppliedAt }`.
- ◆ **MasteryEvidence** — `{ attemptRef, slotRef, itemVersionRef, outcome, itemDifficulty, occurredAt }`. *Bounded window retained inline; full history lives in the response log.*
- ◆ **MasteryTransition** — `{ from, to, qualifyingEvidence[], verifyingEvidence[], verifiedAt, isRegression }`. **A `weak → strong` transition with `verifiedAt` set is one north-star event.**

### ⬢ ReviewSchedule · AR
**Purpose** Convert short-term correctness into retention.
**Responsibilities** Schedule per **concept**, never per item — the learner must not memorize a specific question; shorten intervals on repeated failure and escalate to remediation rather than more repetition.
**Relationships** References `UserId`, `ConceptIdentityId`. Read by next-best-action (FR-STU-05).
**Key attributes** `scheduleId` · `userId` · `entries[]` (`{ conceptIdentityId, dueAt, intervalDays, consecutiveSuccesses, lapseCount }`)

### ⬢ ErrorEntry · AR
**Purpose** Make every mistake a retrievable, actionable object.
**Responsibilities** Auto-create on every incorrect response; clear only on *verified* mastery, never on a single correct re-attempt; retain for the account lifetime.
**Relationships** References `AttemptId`, `slotId`, `ItemVersionId`, `ConceptIdentityId`.
**Key attributes** `entryId` · `userId` · `attemptSlotRef` · `conceptIdentityId` · `errorCause?` (conceptual / calculation / misread / time / guess — learner-supplied) · `annotation?` · `resolvedByTransitionId?`

### ⬢ PracticePolicy · VO *(referenced by Attempt — D2)*
`{ selectionStrategy (filtered / targeted / spaced_review / adaptive[H1]), scopeFilter, difficultyBand, excludeRecentlySeen, feedbackMode: immediate, pausable: true }`

### ⬢ Bookmark · AR
**Purpose** Deliberate set-aside by the learner.
**Key attributes** `bookmarkId` · `userId` · `itemId` · `label?` · `createdAt` · Resolves to the current published version; retained and marked when the item retires.

### ⬢ StudyPlan · AR *(M2)*
**Purpose** Distribute preparation across the time remaining to the exam.
**Responsibilities** Remain advisory and fully overridable; re-plan on missed sessions without punitive framing; preserve revision history for adherence reporting.
**Key attributes** `planId` · `userId` · `examDate` · `weeklyAvailability` · `milestones[]` · `revisions[]` · `adherence` *(derived)*

---

## 10. Context 8 — AI Content

*This context proposes. It never writes Content. (D8)*

### ⬢ GenerationRun · AR
**Purpose** A governed, budgeted, attributable batch of AI content proposals.
**Responsibilities** Pin model and prompt versions; enforce grounding in taxonomy and exemplars; run pre-checks before any human sees a candidate; enforce the budget cap; guarantee every candidate carries complete provenance.
**Relationships** References `ConceptIdentityId`, `ModelVersionId`, `PromptVersionId`, `AIBudgetId`. Emits ▷`CandidateAccepted` → Content ACL. Owns `GenerationCandidate`.
**Key attributes** `runId` · `targetConcepts[]` · `targetDifficulty` · `itemType` · `requestedCount` · `modelVersionId` · `promptVersionId` · `groundingRefs[]` · `budgetConsumed` · `state` · `initiatedBy: PrincipalRef`

- ◆ **GenerationCandidate** — `{ candidateId, proposedStem, proposedResponseSpec, proposedSolution, proposedTags, confidence, preCheckResults[], disposition (rejected_precheck / queued_for_review / accepted / rejected_by_reviewer), rejectionReason? }`.
- ○ **PreCheckResult** — `{ check (answer_verification / scope_conformance / duplicate / difficulty_plausibility / renderability / distractor_validity / factual_consistency), passed, rationale }`. **Answer verification must use a derivation path independent of generation.**

### ⬢ ModelVersion · AR · ⬢ PromptVersion · AR
**Purpose** Make AI behavior reproducible and reversible. *(D1 applied to AI)*
**Responsibilities** Pin explicitly — automatic upgrades are prohibited; support rollback to any prior version; gate promotion behind evaluation.
**Key attributes** `versionId` · `identifier` · `parameters` · `activatedAt?` · `retiredAt?` · `evaluationRunId` *(promotion gate)* · `supersedes?`

### ⬢ EvaluationRun · AR
**Purpose** Prevent silent quality regression from a model or prompt change.
**Responsibilities** Block promotion on regression — warn is not sufficient; continuously absorb reviewer rejection reasons and downstream defects into the golden set.
**Relationships** References `ModelVersionId`, `PromptVersionId`. Gates activation of both.
**Key attributes** `evaluationRunId` · `goldenSetVersion` · `scores[]` · `baselineComparison` · `verdict` (pass / regression) · `promotionDecision`

### ⬢ AIBudget · AR
**Purpose** Keep AI viable at ₹1.30/MAU/month (CST-03).
**Responsibilities** Enforce, not merely monitor; halt non-essential AI on exhaustion; never block core learning features.
**Key attributes** `budgetId` · `scope` (run / feature / user / period) · `limit` · `consumed` · `enforcementAction` · `alertThresholds[]`

### ⬢ TutorConversation · AR *(H1)*
**Purpose** Grounded conversational remediation.
**Responsibilities** Ground strictly in published, reviewed content; scaffold rather than supply answers; escalate suspected content defects to `ItemDefect`; never author or mutate content.
**Key attributes** `conversationId` · `userId` · `contextRefs[]` (item, attempt, concept) · `turns[]` · `groundingCitations[]` · `escalations[]`

---

## 11. Contexts 9–11 — Commerce, Engagement, Trust & Safety

### Commerce

| Aggregate | Purpose | Key attributes & rules |
|---|---|---|
| ⬢ **Plan** | Versioned commercial offering. *(D1)* | `planId` · `versions[]` (each: price, currency, period, `entitlementGrants[]`, taxTreatment). Existing subscribers retain their subscribed version. |
| ⬢ **Subscription** | One learner's commercial relationship over time. | `subscriptionId` · `userId` · **`planVersionId` (pinned)** · `state` (active / past_due / grace / cancelled / expired) · `currentPeriod` · `mandateId?` · `stateHistory[]`. Cancellation retains access through the paid period. |
| ⬢ **QuotaLedger** | The only *stateful* part of entitlement. *(D9)* | `userId` · `period` · `counters[]` (`{ quotaKey, consumed, limit }`). Exhaustion never interrupts an in-progress session. |
| ⬢ **PaymentTransaction** | An idempotent, reconcilable money movement. | `transactionId` · **`idempotencyKey`** · `subscriptionId?` · `amount` · `state` · `pspReference` · `reconciledAt?`. **No card data ever (SEC-16 / CMP-08).** |
| ⬢ **Mandate** | Recurring UPI/card authorization. | `mandateId` · `userId` · `pspMandateRef` · `maxAmount` · `state` · `preDebitNotifications[]`. A price change requires a **new** mandate. |
| ⬢ **Invoice** | Statutory tax document — immutable. | `invoiceId` · `transactionId` · `lineItems[]` · `taxBreakdown` · `issuedAt`. Corrections are credit notes, never edits. Retained 8 years. |
| ⬢ **Promotion** | Discount definition with enforced eligibility. | `promotionId` · `eligibilityRules` · `usageCaps` · `validity` *(mandatory expiry)* · `stackable: false` by default. |
| ⬢ **RefundRequest** | Governed reversal. | `requestId` · `transactionId` · `reason` · `approvalState` · `approvedBy?`. Adjusts entitlement; never deletes academic history. |
| ○ **EntitlementSet** *(derived — D9)* | Computed from Subscription + PlanVersion at evaluation time. Never stored. Correctness content is always granted (INV-08). |

### Engagement

| Aggregate | Purpose | Key attributes & rules |
|---|---|---|
| ⬢ **NotificationTemplate** | Registered, versioned message definition. | `templateId` · `category` (transactional / academic / engagement / promotional / system) · `versions[]` · `localeVariants[]`. Ad-hoc sends are prohibited. |
| ⬢ **NotificationPreference** | Per-user, per-category, per-channel control. | `userId` · `preferences[]` · `quietHours` · `timezone`. Transactional cannot be disabled. Minors default to the most restrictive setting. |
| ⬢ **NotificationInstance** | One message to one recipient. | `instanceId` · `userId` · `templateVersionId` · `channel` · `state` · `suppressionReason?`. **Never sent during an in-progress mock attempt.** |
| ⬢ **DeliveryLedger** | Frequency-cap enforcement. | `userId` · `window` · `countsByCategory[]`. Tighter caps for minors. |

### Trust & Safety

| Aggregate | Purpose | Key attributes & rules |
|---|---|---|
| ⬢ **ModerationCase** | A report, its triage, and its decision. | `caseId` · `targetRef` (content / user / conversation) · `category` · `severity` · `reports[]` · `decision?` · `rationale`. Reporter identity is never disclosed to the reported party. |
| ⬢ **Sanction** | A proportionate, appealable consequence. | `sanctionId` · `userId` · `level` (warning / restriction / suspension / termination) · `evidence[]` · `appeal?`. Restricts access; never deletes academic history. Appeals reviewed by a different principal. |
| ⬢ **AbuseSignal** | Advisory behavioural signal. | `signalId` · `userId` · `signalType` (improbable_concurrency / extraction_pattern / timing_anomaly) · `confidence`. **Never triggers an automatic sanction.** No biometrics, no surveillance. |

---

## 12. Ratification Proposals

Two definitions were carried forward as blocking. Both are domain decisions — proposed here for your ratification.

### 12.1 `NumericAnswerSpec` — closes PRD §15 M3

```
NumericAnswerSpec {
  expectedValue        : Decimal
  comparisonMode       : EXACT | ABSOLUTE_TOLERANCE | RELATIVE_TOLERANCE
                       | SIGNIFICANT_FIGURES | RANGE
  toleranceValue?      : Decimal          // ± for ABSOLUTE; fraction for RELATIVE
  significantFigures?  : Integer          // for SIGNIFICANT_FIGURES
  rangeMin?, rangeMax? : Decimal          // for RANGE (inclusive)
  unit?                : UnitSpec { canonical, acceptedEquivalents[], required: bool }
  acceptedForms        : [ DECIMAL, FRACTION, SCIENTIFIC ]
  normalization        : { trimWhitespace, stripThousandsSeparator,
                           unicodeMinusToAscii, caseInsensitiveUnit }
}
```

**Rules**
1. Normalization is applied to learner input **before** comparison, never after.
2. `ABSOLUTE_TOLERANCE` is the default for JEE Main numerical items; `toleranceValue` defaults from `ExamProfileVersion.toleranceDefaults` and is overridable per item.
3. A unit is compared only when `unit.required = true`; otherwise a supplied unit is stripped during normalization.
4. `SIGNIFICANT_FIGURES` compares after rounding both values to the stated precision.
5. An item with `comparisonMode` requiring a parameter that is absent is **invalid** and cannot be published (FR-TCH-07 blocking validation).
6. Evaluation is pure and deterministic — it is part of the golden-set regression surface (REL-03/04).

### 12.2 Concept Mastery — closes PRD §15 M6

**States:** `unassessed` → `weak` → `developing` → `strong`

**Promotion to `strong` requires *all* of:**
1. ≥ **8** scored responses on the concept
2. across ≥ **4** distinct items
3. across ≥ **2** distinct sessions
4. accuracy ≥ **80%** over the most recent 8 responses
5. at least **3** of those responses on items at or above the learner's demonstrated difficulty band

**Verification (the north-star gate).** A `weak → strong` transition is recorded as a **MasteryGain** only when confirmed by ≥ **2** further correct responses on *different* items, in a *different* session, occurring ≥ **48 hours** after the qualifying evidence. Immediate post-remediation correctness alone never counts — it is confounded by recency.

**Decay.** Confidence decays with elapsed time since last evidence. A `strong` state falling below the confidence floor moves to `developing` and re-enters the spaced-review queue. A verified gain that later regresses is recorded as a **regression**; the original gain is retained, never deleted.

**Confidence** is a function of evidence count, item difficulty spread, session diversity, and recency. States below the evidence threshold are always reported as low-confidence, never asserted (FR-STU-04).

*All thresholds above are configuration, not code — tunable per exam without a model change.*

---

## 13. Invariant → Enforcement Map

Proof that the model makes the FRS §1 invariants structural rather than procedural.

| Invariant | Enforced by | Mechanism |
|---|---|---|
| INV-01 AI never publishes unreviewed | Context boundary (D8) | No code path exists from `GenerationCandidate` to a published `ItemVersion` without a `ReviewDecision`. |
| INV-02 Attribution + audit on every mutation | `PrincipalRef` + `AuditRecord` | Required parameter on every aggregate command. |
| INV-03 Published content immutable | `Item` / `Stimulus` / `Solution` | `ItemVersion` has no mutating operations after publication. |
| INV-04 Attempts pin versions | `Attempt.attemptPin`, `FormItemSlot.itemVersionId` | Version IDs are captured at start, not resolved at read time. |
| INV-05 Server-authoritative scoring | `ScoreRecord` | Only Scoring may produce a `ScoreRecord`; the client has no such capability. |
| INV-06 No response loss | `ResponseEvent` append-only log (D4) | No delete or update operation is defined on the log. |
| INV-07 Publication completeness | `Item` publication precondition | Refuses transition without tags, provenance, resolved licensing, and reviewer signature. |
| INV-08 Correctness never paywalled | `EntitlementSet` (D9) | Basic correctness is an unconditional grant, not a plan-derived one. |
| INV-09 Support cannot mutate academic records | Role scope + context boundary | Support role holds no command capability in Assessment, Scoring, or Content. |
| INV-10 Minors' consent | `Consent` + `User.isMinor` | Processing commands require a valid guardian attestation. |
| INV-11 Dual-result retention | `ScoreRecord` generations (D3) | Re-scoring appends; mutation is undefined. |
| INV-12 No self-review | `ReviewAssignment` + `Item` | Assignment excludes the authoring principal; the review command re-checks. |
| INV-13 Deletion retains de-identified aggregates | `User` deletion + derived aggregates | `ItemStatistics` / `FormStatistics` hold no `UserId`. |
| INV-14 Deterministic rendering | `ContentBody` VO | Structured markup only; no pre-rendered or image-of-text representation exists in the model. |
| INV-15 Server-side entitlement | `EntitlementSet` derivation | Computed from `Subscription`; no client-supplied entitlement input. |

---

## 14. Aggregate Inventory

**51 aggregate roots** across 11 contexts.

| Context | Aggregate Roots |
|---|---|
| Identity & Access | User, Consent, Session, AuditRecord |
| Curriculum | ConceptIdentity, TaxonomyVersion, TaxonomyMigration, Exam, ExamProfileVersion |
| Content | Item, Stimulus, Solution, MediaAsset, ReviewAssignment, ItemDefect, AnswerKeyChallenge |
| Assessment | Form, Attempt |
| Scoring | ScoreRecord, RescoringOperation |
| Psychometrics | ItemStatistics, ExposureLedger, FormStatistics, CalibrationRun |
| Learning | LearnerProfile, ConceptMap, ReviewSchedule, ErrorEntry, Bookmark, StudyPlan |
| AI Content | GenerationRun, ModelVersion, PromptVersion, EvaluationRun, AIBudget, TutorConversation |
| Commerce | Plan, Subscription, QuotaLedger, PaymentTransaction, Mandate, Invoice, Promotion, RefundRequest |
| Engagement | NotificationTemplate, NotificationPreference, NotificationInstance, DeliveryLedger |
| Trust & Safety | ModerationCase, Sanction, AbuseSignal |

**Extraction seams** (Phase 2 candidates, ordered by independence): AI Content → Psychometrics → Engagement → Trust & Safety. Content + Curriculum and Assessment + Scoring should stay co-deployed until proven otherwise — their coupling is tight and their consistency requirements are strict.

---
