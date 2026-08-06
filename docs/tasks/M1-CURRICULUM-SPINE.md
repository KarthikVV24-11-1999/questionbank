# M1 — Curriculum Spine · Task Breakdown
**Milestone:** [ROADMAP.md](../ROADMAP.md) M1 · **Duration:** 4 weeks · **Depends on:** M0, ratification of D-001
**Deployable:** taxonomy and exam profiles queryable via API, manageable in Studio

> 35 tasks, each independently testable. Paths follow [ENGINEERING-HANDBOOK.md](../ENGINEERING-HANDBOOK.md) §1–2.

**Scope boundary:** M1 *stores and validates* marking rule sets. It does **not** execute them — the rule executor is M2. This split keeps the two independently testable and puts the golden-set gate on the executor where it belongs.

---

## Task Index

| ID | Task | Track | Depends on |
|---|---|---|---|
| M1-01 | `ConceptIdentity` aggregate | A · domain | — |
| M1-02 | `ConceptNode` & `PrerequisiteEdge` entities | A · domain | 01 |
| M1-03 | `TaxonomyVersion` tree invariants | A · domain | 02 |
| M1-04 | `TaxonomyVersion` lifecycle & publication | A · domain | 03 |
| M1-05 | `NumericAnswerSpec` value object | A · domain | — |
| M1-06 | `TimingPolicy` & `NavigationPolicy` value objects | A · domain | — |
| M1-07 | `MarkingRuleSet` schema & structural validation | A · domain | — |
| M1-08 | `MarkingRuleSet` canonical hashing | A · domain | 07 |
| M1-09 | `SectionSpec` & blueprint consistency | A · domain | — |
| M1-10 | `Exam` aggregate | A · domain | — |
| M1-11 | `ExamProfileVersion` aggregate & publication preconditions | A · domain | 05–10 |
| M1-12 | `TaxonomyMigration` mapping model | A · domain | 01 |
| M1-13 | Migration exception derivation & dry-run | A · domain | 12 |
| M1-14 | Curriculum schema migration | B · data | — |
| M1-15 | Published-row immutability triggers | B · data | 14 |
| M1-16 | Taxonomy repositories | B · data | 04, 14 |
| M1-17 | Exam profile repositories | B · data | 11, 14 |
| M1-18 | Migration repository | B · data | 13, 14 |
| M1-19 | Taxonomy commands & handlers | C · app | 16 |
| M1-20 | Exam profile commands & handlers | C · app | 17 |
| M1-21 | Migration commands & handlers | C · app | 18 |
| M1-22 | Curriculum queries | C · app | 16, 17 |
| M1-23 | Public barrel & boundary enforcement | C · app | 19–22 |
| M1-24 | Domain events & outbox emission | C · app | 19, 20 |
| M1-25 | OpenAPI contract & generated types | D · api | 23 |
| M1-26 | Curriculum controllers | D · api | 25 |
| M1-27 | Taxonomy import format & loader | E · data | 19 |
| M1-28 | JEE Main 2026 taxonomy dataset | E · content | 27 |
| M1-29 | JEE Main 2026 exam profile | E · content | 20 |
| M1-30 | **NEET UG exam profile — EXT-01 proof** | E · content | 29 |
| M1-31 | Local seed integration | E · data | 28, 29 |
| M1-32 | Studio taxonomy browser | F · ui | 26 |
| M1-33 | Studio taxonomy draft editor | F · ui | 32 |
| M1-34 | Studio exam profile viewer | F · ui | 26 |
| M1-35 | Studio migration console | F · ui | 26 |

---

## Track A — Curriculum Domain

*Pure logic. No I/O, no framework, no ORM. Every task here is unit-testable in isolation.*

### M1-01 · `ConceptIdentity` aggregate
**Objective** The permanent, version-independent identity of a concept (D1).
**Files** `apps/api/src/contexts/curriculum/domain/concept-identity.ts`
**Acceptance**
- Holds `conceptIdentityId`, `canonicalName`, `subjectDomain`, `createdInVersion`, `supersededBy?`
- Identity is immutable after creation; only `supersededBy` may be set, and only once
- `canonicalName` is non-empty and normalized (trimmed, collapsed whitespace)
**Tests** Unit: construction validity · immutability rejection · supersede-once enforcement · name normalization

### M1-02 · `ConceptNode` & `PrerequisiteEdge` entities
**Objective** A concept's placement within one taxonomy version, and the prerequisite graph.
**Files** `domain/concept-node.ts`, `domain/prerequisite-edge.ts`
**Acceptance**
- `ConceptNode` carries `conceptIdentityId`, `parentNodeId?`, `displayName`, `examWeight`, `depth`, `estimatedTeachingHours`
- `examWeight` ∈ [0, 1]; `depth` derived from parent chain, never supplied
- `PrerequisiteEdge` carries from/to concept identities and `strength` ∈ [0, 1]
- Self-referencing edges rejected at construction
**Tests** Unit: field validation · depth derivation · self-edge rejection

### M1-03 · `TaxonomyVersion` tree invariants
**Objective** Guarantee structural integrity of the concept hierarchy and prerequisite graph.
**Files** `domain/taxonomy-version.ts`, `domain/taxonomy-invariants.ts`
**Acceptance**
- Exactly one root per subject domain
- No orphan nodes; every non-root has a resolvable parent
- No cycles in the parent hierarchy
- **No cycles in the prerequisite graph** — enforced on every edge addition
- No duplicate `conceptIdentityId` within a version
- Violations raise a typed domain error naming the offending nodes
**Tests** Unit: valid tree accepted · orphan rejected · parent cycle rejected · prerequisite cycle rejected (including 3-node indirect) · duplicate identity rejected · error names the nodes

### M1-04 · `TaxonomyVersion` lifecycle & publication
**Objective** The draft → published → superseded state machine with publication immutability.
**Files** `domain/taxonomy-version.ts`, `domain/taxonomy-lifecycle.ts`
**Acceptance**
- States: `draft` · `published` · `superseded`. Only draft→published and published→superseded are legal
- Publication runs all M1-03 invariants and fails atomically on any violation
- A published version rejects every mutation with a typed error
- Publication stamps `publishedAt` and the publishing `PrincipalRef`
- A concept cannot be removed while referenced (checked at publication)
**Tests** Unit: legal transitions · every illegal transition rejected · post-publication mutation rejected for each mutator · invariant failure blocks publication and leaves state unchanged

### M1-05 · `NumericAnswerSpec` value object
**Objective** Ratified D-001 as a validated, immutable type. **Structure and validation only — evaluation is M2.**
**Files** `domain/value-objects/numeric-answer-spec.ts`
**Acceptance**
- All five comparison modes representable: `EXACT`, `ABSOLUTE_TOLERANCE`, `RELATIVE_TOLERANCE`, `SIGNIFICANT_FIGURES`, `RANGE`
- Mode-specific required parameters enforced: `ABSOLUTE`/`RELATIVE` require `toleranceValue`; `SIGNIFICANT_FIGURES` requires `significantFigures`; `RANGE` requires both bounds with min ≤ max
- `UnitSpec` with canonical form, accepted equivalents, `required` flag
- `acceptedForms` non-empty subset of `{DECIMAL, FRACTION, SCIENTIFIC}`
- Normalization flags all present with defaults
- Missing a mode-required parameter is a construction error, not a runtime surprise
**Tests** Unit: valid spec per mode · each missing-parameter case rejected · `rangeMin > rangeMax` rejected · empty `acceptedForms` rejected · immutability

### M1-06 · `TimingPolicy` & `NavigationPolicy` value objects
**Objective** Declarative delivery rules for an exam profile.
**Files** `domain/value-objects/timing-policy.ts`, `domain/value-objects/navigation-policy.ts`
**Acceptance**
- `TimingPolicy`: `totalDurationMinutes` > 0, `sectionLocking`, `warningThresholdsMinutes[]` (descending, all < total), `autoSubmitOnExpiry`
- `NavigationPolicy`: `crossSectionNavigation`, `allowMarkForReview`, `allowAnswerChange`, `allowClearResponse`
- **`sectionLocking = true` with `crossSectionNavigation = true` is rejected as contradictory**
- Both immutable
**Tests** Unit: valid construction · non-descending thresholds rejected · threshold ≥ total rejected · contradictory locking/navigation combination rejected

### M1-07 · `MarkingRuleSet` schema & structural validation
**Objective** The keystone type from [ASSESSMENT-ENGINE.md](../ASSESSMENT-ENGINE.md) §2 — schema and validation, not execution.
**Files** `domain/value-objects/marking-rule-set.ts`, `domain/value-objects/marking-rule.ts`, `domain/value-objects/condition.ts`, `domain/value-objects/award.ts`
**Acceptance**
- All eight conditions representable: `UNATTEMPTED`, `EXACT_MATCH`, `NO_MATCH`, `ALL_CORRECT_SELECTED`, `PARTIAL_CORRECT_SELECTED{minCorrect,noIncorrect}`, `ANY_INCORRECT_SELECTED`, `MATCHING_PAIRS_CORRECT{count}`, `ALWAYS`
- All three awards representable: `FIXED{marks}`, `PER_CORRECT{marks}`, `FULL_MARKS`
- **A rule set must terminate in an `ALWAYS` rule** — rejected otherwise (F46)
- Rule IDs unique within the set
- Rules are ordered; order is preserved and significant
- `schemaVersion` mandatory
- A condition unreachable because an earlier rule subsumes it produces a **warning**, not an error
**Tests** Unit: each condition and award constructs · missing `ALWAYS` rejected · `ALWAYS` not last rejected · duplicate rule ID rejected · order preserved through serialization round-trip · **JEE Main 3-rule set validates** · **JEE Advanced 7-rule set validates** · unreachable-rule warning raised

### M1-08 · `MarkingRuleSet` canonical hashing
**Objective** A stable hash pinned into every future `ScoreRecord`. Mitigates R2.
**Files** `domain/value-objects/marking-rule-set-hash.ts`
**Acceptance**
- Hash is computed over a **canonical serialization**: keys sorted, no whitespace, explicit numeric formatting
- Semantically identical rule sets produce identical hashes regardless of construction path or key insertion order
- Any semantic change — rule order, a mark value, a condition parameter — changes the hash
- Hash incorporates `schemaVersion`
- Hash is stable across process restarts and library versions
**Tests** Unit: identical sets hash equal across 1,000 shuffled constructions · each field mutation changes the hash · reordering rules changes the hash · **golden hash fixtures for the JEE Main and JEE Advanced sets committed and asserted**

### M1-09 · `SectionSpec` & blueprint consistency
**Objective** A profile's section structure and its internal arithmetic.
**Files** `domain/section-spec.ts`
**Acceptance**
- Carries `ordinal`, `name`, `subject`, `itemCount`, `itemTypeMix`, `maxMarks`, `sectionTiming?`
- Ordinals contiguous from 1, no gaps or duplicates
- `itemTypeMix` counts sum exactly to `itemCount`
- Sum of section `maxMarks` equals the profile total
- `sectionTiming` present only when the profile's `TimingPolicy.sectionLocking` is true
**Tests** Unit: valid spec · ordinal gap rejected · type-mix sum mismatch rejected · marks mismatch rejected · section timing without locking rejected

### M1-10 · `Exam` aggregate
**Objective** The stable identity of an examination (D1).
**Files** `domain/exam.ts`
**Acceptance**
- Carries `examId`, `code` (unique), `displayName`, `jurisdiction`, `conductingBody`
- Tracks active profile versions by academic year
- **At most one active profile version per academic year** — a second is rejected
- `code` is immutable after creation
**Tests** Unit: construction · duplicate-year activation rejected · code immutability

### M1-11 · `ExamProfileVersion` aggregate & publication preconditions
**Objective** The multi-exam plugin contract — the composition point for everything in Track A.
**Files** `domain/exam-profile-version.ts`
**Acceptance**
- Composes `SectionSpec[]`, `TimingPolicy`, `NavigationPolicy`, `MarkingRuleSet`, `ToleranceDefault`, `itemTypeAllowances[]`, `taxonomyVersionId`
- States: `draft` · `published` · `superseded`
- **Publication preconditions, all required:** blueprint arithmetic consistent (M1-09) · rule set valid and `ALWAYS`-terminated (M1-07) · every `itemTypeAllowance` has at least one matching marking rule · referenced `taxonomyVersionId` is published · `goldenSetValidation` field present *(M2 populates it; M1 only requires the field)*
- Published versions reject all mutation
- `markingRuleSetHash` computed and frozen at publication
**Tests** Unit: valid profile publishes · each precondition failure blocks publication independently · post-publication mutation rejected · item type with no matching rule rejected · **JEE Main 2026 profile publishes** · **JEE Advanced-shaped profile publishes with zero code change**

### M1-12 · `TaxonomyMigration` mapping model
**Objective** Represent every kind of change between two taxonomy versions.
**Files** `domain/taxonomy-migration.ts`, `domain/taxonomy-mapping.ts`
**Acceptance**
- Mapping kinds: `IDENTITY`, `RENAME`, `MOVE`, `SPLIT`, `MERGE`, `REMOVAL`
- Cardinality enforced per kind: `SPLIT` is 1→n (n≥2), `MERGE` is n→1 (n≥2), others 1→1 except `REMOVAL` (1→0)
- Every mapping references concept identities in the correct version
- A concept may appear in at most one mapping per migration
**Tests** Unit: each kind constructs valid · wrong cardinality rejected per kind · duplicate concept across mappings rejected · reference to an absent concept rejected

### M1-13 · Migration exception derivation & dry-run
**Objective** Produce the exception list requiring human disposition, without mutating anything.
**Files** `domain/migration-dry-run.ts`
**Acceptance**
- **`IDENTITY` and `RENAME` migrate automatically; `MOVE`, `SPLIT`, `MERGE`, `REMOVAL` always produce exceptions**
- Any concept present in the source version with no mapping produces an `UNMAPPED` exception
- Dry-run output lists: auto-migratable count, exception list with kind and affected concepts, and any invalid mapping
- **Dry-run performs no mutation** — it is a pure function of two versions plus the mapping set
- Result is deterministic and reproducible
**Tests** Unit: identity-only migration yields zero exceptions · each ambiguous kind yields an exception · unmapped concept detected · dry-run is pure (no state change observable) · determinism across 100 runs

---

## Track B — Persistence

### M1-14 · Curriculum schema migration
**Objective** Physical tables per [DATA-ARCHITECTURE.md](../DATA-ARCHITECTURE.md) §4.
**Files** `infra/migrations/<ts>_curriculum_schema.sql`, `apps/api/src/contexts/curriculum/infrastructure/schema.ts`
**Acceptance**
- Tables: `concept_identity`, `taxonomy_version`, `concept_node`, `prerequisite_edge`, `taxonomy_migration`, `taxonomy_mapping`, `exam`, `exam_profile_version`, `exam_section_spec`
- All in the `curriculum` schema; **no foreign key crosses a schema boundary** (F2)
- UUIDv7 primary keys (P6); `tenant_id` on tenancy-scoped tables (P7)
- JSONB columns each have a sibling `*_schema_version` (F5): `timing_policy`, `navigation_policy`, `marking_rule_set`, `tolerance_defaults`
- `marking_rule_set_hash` stored alongside the JSONB
- Migration is reversible; down-migration verified
**Tests** Integration: migration applies to a clean database · down-migration reverses cleanly · FK constraints enforced · CI check for cross-schema FKs · CI check for JSONB sibling columns

### M1-15 · Published-row immutability triggers
**Objective** Enforce publication immutability at the database, not in application code.
**Files** `infra/migrations/<ts>_curriculum_immutability.sql`
**Acceptance**
- `BEFORE UPDATE` trigger on `taxonomy_version` rejects any update where `OLD.state = 'published'`
- Same on `exam_profile_version`
- Trigger permits the single `published → superseded` transition and nothing else
- Cascading child tables (`concept_node`, `prerequisite_edge`, `exam_section_spec`) reject mutation when the parent is published
- **The trigger fires regardless of connection role** — a direct `psql` update is rejected
**Tests** Integration: update to a published version rejected via ORM · rejected via raw SQL · rejected on each child table · `published → superseded` permitted · draft updates unaffected

### M1-16 · Taxonomy repositories
**Objective** Persist and reconstitute `ConceptIdentity` and `TaxonomyVersion`.
**Files** `infrastructure/concept-identity.repository.ts`, `infrastructure/taxonomy-version.repository.ts`
**Acceptance**
- Full aggregate round-trip: save then load yields a domain-equal object
- Loading a version reconstitutes all nodes and edges with correct parent links
- Optimistic concurrency via `aggregate_version`; a stale write raises `Conflict`
- `snake_case` ↔ `camelCase` mapping happens **here and nowhere else**
- No domain type imports the ORM
**Tests** Integration (real Postgres): round-trip equality on a 600-node version · concurrent write conflict raised · partial-load rejection · unit: mapping correctness

### M1-17 · Exam profile repositories
**Objective** Persist and reconstitute `Exam` and `ExamProfileVersion`.
**Files** `infrastructure/exam.repository.ts`, `infrastructure/exam-profile-version.repository.ts`
**Acceptance**
- Round-trip preserves rule set semantics **and hash** exactly
- JSONB validated against the registered schema on write; invalid JSONB rejected before it reaches the database
- Section specs load in ordinal order
- Optimistic concurrency enforced
**Tests** Integration: round-trip with hash equality · invalid JSONB rejected · ordinal ordering preserved · concurrency conflict

### M1-18 · Migration repository
**Objective** Persist migrations, mappings, and dry-run results.
**Files** `infrastructure/taxonomy-migration.repository.ts`
**Acceptance**
- Round-trip preserves mapping kinds and cardinality
- Dry-run result persisted as JSONB with a schema version
- A migration in `executing` state cannot be modified
**Tests** Integration: round-trip · state-guard enforcement

---

## Track C — Application

### M1-19 · Taxonomy commands & handlers
**Objective** The write surface for taxonomy management.
**Files** `application/commands/*.ts`, `application/handlers/*.ts`
**Acceptance**
- Commands: `CreateTaxonomyDraft`, `AddConceptNode`, `MoveConceptNode`, `AddPrerequisiteEdge`, `RemoveConceptNode`, `PublishTaxonomyVersion`
- **Every handler declares an authorization policy; the module fails to boot without one** (F36)
- Exactly one aggregate mutated per transaction
- Handlers return typed results; they do not throw for domain failures
- Every mutation writes an `AuditRecord` with `PrincipalRef`
**Tests** Unit: handler logic with in-memory repository · integration: transaction boundary · **authorization negative path per handler, 100%** · boot failure on a missing policy · audit record written

### M1-20 · Exam profile commands & handlers
**Objective** The write surface for exam profiles.
**Files** `application/commands/*.ts`, `application/handlers/*.ts`
**Acceptance**
- Commands: `CreateExam`, `CreateProfileDraft`, `UpdateProfileDraft`, `PublishProfileVersion`, `SupersedeProfileVersion`
- Publication is atomic: all preconditions evaluated before any write
- Publishing requires step-up authorization
**Tests** Unit + integration as M1-19 · precondition failure leaves no partial write · step-up requirement enforced

### M1-21 · Migration commands & handlers
**Objective** The governed migration workflow.
**Files** `application/commands/*.ts`, `application/handlers/*.ts`
**Acceptance**
- Commands: `CreateMigration`, `AddMapping`, `RunDryRun`, `ExecuteMigration`
- **`ExecuteMigration` is rejected unless a dry-run exists and every exception is dispositioned**
- Execution requires step-up authorization
- Execution is chunked and resumable; it never runs as a single long transaction
**Tests** Unit: execution rejected without dry-run · rejected with undispositioned exceptions · integration: chunked execution resumes after interruption · step-up enforced

### M1-22 · Curriculum queries
**Objective** The read surface.
**Files** `application/queries/*.ts`
**Acceptance**
- Queries: `GetTaxonomyVersion`, `ListTaxonomyVersions`, `GetConceptSubtree`, `GetConceptPrerequisites`, `GetExamProfileVersion`, `ListExams`, `GetMigrationDryRun`
- Each declares an authorization policy
- `GetConceptSubtree` supports depth limiting
- Read models are DTOs, never domain aggregates
**Tests** Unit: projection correctness · integration: query results against seeded data · authorization negative paths

### M1-23 · Public barrel & boundary enforcement
**Objective** Make the curriculum context consumable without leaking its internals.
**Files** `contexts/curriculum/public/index.ts`
**Acceptance**
- Exports exactly three categories: commands, queries, events
- **No domain aggregate, entity, repository, or infrastructure type is exported**
- Another module importing outside the barrel fails CI (F1)
- Value objects required by consumers (`NumericAnswerSpec`, `MarkingRuleSet`) are exported as read-only DTOs, not domain types
**Tests** CI: dependency-cruiser rule with a planted violation · unit: barrel surface snapshot test

### M1-24 · Domain events & outbox emission
**Objective** Publish curriculum facts for downstream contexts.
**Files** `domain/events/*.ts`, `infrastructure/outbox-emitter.ts`
**Acceptance**
- Events: `TaxonomyVersionPublished`, `ExamProfileVersionPublished`, `TaxonomyMigrationExecuted`
- Each written to `outbox_message` **in the same transaction** as the aggregate change (P4)
- Event payloads carry IDs only — never full aggregates
- Each event has a registered analytics counterpart or an explicit exemption (F18)
**Tests** Integration: event and aggregate committed atomically · rollback discards both · payload shape assertion · CI: event registry completeness

---

## Track D — API

### M1-25 · OpenAPI contract & generated types
**Objective** The curriculum API contract as the source of truth.
**Files** `packages/contracts/openapi/curriculum.yaml`, generated output in `packages/contracts/src/`
**Acceptance**
- Every command and query has a documented operation
- Cursor pagination on all list endpoints; no offset parameters
- Filter and sort fields allowlisted per endpoint
- RFC 9457 error schema with the closed error-code set
- `camelCase` JSON throughout
- Types generate cleanly for TypeScript clients
**Tests** Contract: spec validates against OpenAPI 3.1 · generated types compile · CI check that every public endpoint appears in the spec (F15)

### M1-26 · Curriculum controllers
**Objective** Wire HTTP to handlers, with no logic of its own.
**Files** `api/curriculum.controller.ts`, `api/dto/*.ts`
**Acceptance**
- Controllers contain zero business logic — they translate and delegate
- Request DTOs validated by Zod schemas generated from OpenAPI
- Domain errors map to the correct HTTP status and `code`
- ETag / `If-Match` on mutating endpoints, mapped to `aggregate_version`
- `Idempotency-Key` accepted on publish operations
- Correlation ID present in every response, including errors
**Tests** Integration: each endpoint happy path · each error class returns the correct status and code · concurrency conflict returns 409 · malformed DTO returns 400 with field detail · contract tests green

---

## Track E — Content & Data

### M1-27 · Taxonomy import format & loader
**Objective** Load a full taxonomy from a versioned file, so content is reviewable in git.
**Files** `tools/seed/taxonomy-loader.ts`, `tools/seed/schema/taxonomy.schema.json`
**Acceptance**
- Format is YAML with a declared schema version
- Loader validates the entire file before writing anything — all-or-nothing
- Per-record errors reported with file location, not just "invalid"
- Loading is idempotent: re-running the same file changes nothing
- Loader produces a draft version, never a published one
**Tests** Unit: schema validation with fixture files · integration: 600-node load · malformed file rejected with locations · idempotent re-run

### M1-28 · JEE Main 2026 taxonomy dataset
**Objective** The real curriculum content — a data task, not an engineering one.
**Files** `tools/seed/data/jee-main-2026.taxonomy.yaml`
**Acceptance**
- ~600 concepts across Physics, Chemistry, Mathematics
- Hierarchy matches the official NTA syllabus structure
- `examWeight` assigned per chapter, summing to 1.0 per subject
- Prerequisite edges present for genuinely dependent concepts, acyclic
- Passes M1-27 validation and publishes cleanly under M1-04
- **Subject-matter reviewed and signed off before merge**
**Tests** Integration: file loads and publishes · invariant suite passes on the real dataset · weight sums asserted · manual SME review recorded in the PR

### M1-29 · JEE Main 2026 exam profile
**Objective** The v1 exam configuration.
**Files** `tools/seed/data/jee-main-2026.profile.yaml`
**Acceptance**
- 3 sections (Physics, Chemistry, Mathematics), 25 items each, 20 MCQ + 5 numeric
- 300 total marks; 180-minute single timer; `sectionLocking: false`; free cross-section navigation
- Marking rule set is the 3-rule JEE Main set from [ASSESSMENT-ENGINE.md](../ASSESSMENT-ENGINE.md) §2.4
- Tolerance defaults present for numeric items
- Publishes with every precondition satisfied
**Tests** Integration: profile loads and publishes · blueprint arithmetic asserted · rule set validates · hash matches the committed golden fixture

### M1-30 · NEET UG exam profile — **the EXT-01 proof**
**Objective** Demonstrate the multi-exam claim with configuration alone. **This is M1's most important acceptance criterion.**
**Files** `tools/seed/data/neet-ug-2026.profile.yaml`
**Acceptance**
- 180 items (Physics 45, Chemistry 45, Biology 90), 720 marks, 200 minutes
- Single-correct MCQ only; the same 3-rule marking set with different section structure
- Publishes successfully
- **Zero changes to any file outside `tools/seed/data/`** — asserted by a diff check in CI
- **Zero schema migrations required**
**Tests** Integration: profile publishes · **CI assertion that the commit touches only data files** · schema-diff assertion against the pre-NEET migration state

### M1-31 · Local seed integration
**Objective** `pnpm seed` produces a working curriculum for every developer.
**Files** `tools/seed/index.ts`, `package.json` script
**Acceptance**
- One command loads and publishes both taxonomies and all three profiles
- Completes in ≤ 60 seconds on a clean database
- Idempotent — safe to re-run
- Included in the Compose boot verification (F8)
**Tests** Integration: seed on a clean database · re-run idempotency · timing assertion in CI

---

## Track F — Studio

*Desktop-only, ≥1280px, gated below (FRONTEND §9).*

### M1-32 · Studio taxonomy browser
**Objective** Read-only navigation of a published taxonomy.
**Files** `apps/studio/src/routes/taxonomy/`, `apps/studio/src/features/taxonomy/`
**Acceptance**
- Version selector; tree view with lazy-loaded subtrees
- Concept detail: identity, weight, prerequisites, item count *(count stubbed until M3)*
- Search within a version
- Published versions visibly read-only
- Loads a 600-node tree with p95 interaction < 200 ms
**Tests** Component: tree rendering and expansion · E2E: navigate to a concept and view detail · accessibility scan clean · performance budget assertion

### M1-33 · Studio taxonomy draft editor
**Objective** Create and edit draft taxonomy versions.
**Files** `apps/studio/src/features/taxonomy-editor/`
**Acceptance**
- Create draft from scratch or by cloning a published version
- Add, rename, move, remove concepts; add and remove prerequisite edges
- **Invariant violations surface inline and immediately** — cycles, orphans, duplicates
- Publish action shows every unmet precondition before enabling
- Optimistic concurrency: a stale edit shows a clear conflict, never a silent overwrite
- Fully keyboard-operable
**Tests** Component: each edit operation · E2E: create draft → edit → publish → verify immutability · cycle attempt blocked with a clear message · concurrency conflict surfaced · accessibility scan

### M1-34 · Studio exam profile viewer
**Objective** Inspect an exam profile including its marking rules.
**Files** `apps/studio/src/features/exam-profile/`
**Acceptance**
- Sections, timing, navigation, item-type allowances displayed
- **Marking rules rendered in evaluation order, in plain language** — "If unattempted → 0 marks"
- Rule-set hash shown and copyable
- Published profiles visibly read-only
**Tests** Component: rule rendering for both JEE Main and JEE Advanced sets · E2E: view profile · accessibility scan

### M1-35 · Studio migration console
**Objective** Run a taxonomy migration safely.
**Files** `apps/studio/src/features/taxonomy-migration/`
**Acceptance**
- Select source and target versions; define mappings
- **Dry-run results displayed before execution is offered** — auto-migratable count and full exception list
- Every exception requires explicit disposition before execute is enabled
- Execute requires typed confirmation, not a button click
- Progress shown for chunked execution
**Tests** Component: exception list rendering and disposition · E2E: full dry-run → disposition → execute flow · execute blocked while exceptions remain · accessibility scan

---

## Sequencing

```
Week 1   A01→A04 (taxonomy domain)   ║  A05→A09 (VOs)      ║  B14, B15 (schema)
Week 2   A10→A13 (profile+migration) ║  B16→B18 (repos)    ║  E27 (loader)
Week 3   C19→C24 (application)       ║  D25, D26 (API)     ║  E28, E29 (content)
Week 4   F32→F35 (Studio)            ║  E30, E31 (NEET+seed) ║ hardening
```

**Critical path:** A01 → A03 → A04 → B16 → C19 → D26 → F33 (~15 days)
**Parallel from day one:** Track A value objects (A05–A09) and Track B schema (B14–B15)
**Content track (E28) runs independently** and should start week 1 — it is subject-matter work, not engineering, and is the likeliest task to slip

---

## Milestone Definition of Done

A task is done when merged with tests green. **The milestone** is done when all of the following hold on staging:

- [ ] All 35 tasks merged
- [ ] JEE Main 2026 taxonomy (600 concepts) and profile published
- [ ] **NEET UG profile published with zero non-data file changes** — CI-asserted
- [ ] Every published version rejects mutation via ORM **and** raw SQL
- [ ] Migration dry-run produces a correct exception list on a real version pair
- [ ] JEE Advanced-shaped rule set validates and hashes, proving EXT-03
- [ ] Fitness functions F1, F2, F5, F36, F46 green
- [ ] Authorization negative-path coverage 100% on curriculum handlers
- [ ] `pnpm seed` completes in ≤ 60 s
- [ ] Studio taxonomy and profile surfaces pass automated accessibility scan
- [ ] Deployed to staging and demonstrated end to end

---
