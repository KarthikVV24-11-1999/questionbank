# M1 — Acceptance Criteria Traceability

Every acceptance criterion in [M1-CURRICULUM-SPINE.md](M1-CURRICULUM-SPINE.md) mapped to the test that
proves it. Built 2026-08-05 as part of the M1 close-out audit.

**Legend** — ✅ proven by a test that actually asserts the criterion · ⚠️ partially proven (the test
asserts something weaker than the criterion) · ❌ no test.

Paths are relative to the repo root. `api` = `apps/api/`, `studio` = `apps/studio/`, `seed` = `tools/seed/`.

**Totals: 178 criteria · 168 ✅ · 6 ⚠️ · 4 ❌.** Findings are listed in [M1-CLOSEOUT.md](M1-CLOSEOUT.md).

---

## Track A — Curriculum Domain

### M1-01 · `ConceptIdentity` aggregate

| Criterion | Status | Test |
|---|---|---|
| Holds `conceptIdentityId`, `canonicalName`, `subjectDomain`, `createdInVersion`, `supersededBy?` | ✅ | `api/…/domain/concept-identity.spec.ts` › ConceptIdentity construction › holds the identity, canonical name, subject domain and creating version |
| Identity is immutable after creation | ✅ | same file › ConceptIdentity immutability › rejects reassignment of {conceptIdentityId, canonicalName, subjectDomain, createdInVersion, supersededBy} (5 cases) + is frozen after creation + rejects the addition of new properties + rejects deletion of a property |
| Only `supersededBy` may be set | ✅ | same file › ConceptIdentity supersession › records the superseding identity on a new instance; carries every other field through unchanged |
| …and only once | ✅ | same file › ConceptIdentity supersession › rejects a second supersession; rejects re-supersession by the same identity it was superseded by |
| `canonicalName` non-empty | ✅ | same file › ConceptIdentity construction › rejects an empty canonicalName; …of whitespace only |
| `canonicalName` normalized (trimmed, collapsed whitespace) | ✅ | same file › ConceptIdentity canonical name normalization › 5 normalization cases + treats names differing only in whitespace as the same canonical name + preserves internal casing and punctuation |

### M1-02 · `ConceptNode` & `PrerequisiteEdge`

| Criterion | Status | Test |
|---|---|---|
| `ConceptNode` carries the seven fields | ✅ | `api/…/domain/concept-node.spec.ts` › ConceptNode fields › carries identity, placement, display name, weight and teaching hours |
| `examWeight` ∈ [0, 1] | ✅ | same file › ConceptNode examWeight range › accepts 0/0.001/0.5/1; rejects −0.0001/−1/1.0001/2/NaN/Infinity |
| `depth` derived from parent chain, never supplied | ✅ | same file › ConceptNode depth derivation › gives a root depth 0; derives depth from the parent chain; cannot be supplied by the caller |
| `PrerequisiteEdge` carries from/to and `strength` ∈ [0, 1] | ✅ | `api/…/domain/prerequisite-edge.spec.ts` › PrerequisiteEdge construction › carries the from and to concept identities and the strength; PrerequisiteEdge strength range › accepts 0/0.5/1, rejects −0.01/1.01/NaN/Infinity |
| Self-referencing edges rejected at construction | ✅ | same file › PrerequisiteEdge self-reference › rejects an edge from a concept to itself; rejects a self-edge that differs only by surrounding whitespace |

### M1-03 · `TaxonomyVersion` tree invariants

| Criterion | Status | Test |
|---|---|---|
| Exactly one root per subject domain | ✅ | `api/…/domain/taxonomy-invariants.spec.ts` › root per subject domain › rejects two roots in the same subject domain; rejects a subject domain with no root. Enforced on add: `taxonomy-version.spec.ts` › rejects a second root in the same subject domain |
| No orphan nodes; every non-root has a resolvable parent | ✅ | `taxonomy-invariants.spec.ts` › orphan nodes › rejects a node whose parent is absent from the version; `taxonomy-version.spec.ts` › rejects a node whose parent is not in the version — no orphans |
| No cycles in the parent hierarchy | ✅ | `taxonomy-invariants.spec.ts` › parent hierarchy cycles › rejects a two-node parent cycle; rejects a three-node parent cycle; reports a cycle once even when several nodes hang off it |
| No cycles in the prerequisite graph, enforced on every edge addition | ✅ | `taxonomy-version.spec.ts` › TaxonomyVersion prerequisite edges › rejects an edge that would close a two-node cycle; …a three-node indirect cycle |
| No duplicate `conceptIdentityId` within a version | ✅ | `taxonomy-invariants.spec.ts` › duplicate concept identities › rejects the same concept identity placed on two nodes |
| Violations raise a typed domain error naming the offending nodes | ✅ | `taxonomy-invariants.spec.ts` › violation reporting › names the offending nodes on every violation; reports every violation of a badly formed version at once |
| *(tests)* prerequisite cycle including 3-node indirect | ✅ | `taxonomy-invariants.spec.ts` › prerequisite graph › rejects a three-node indirect prerequisite cycle |

### M1-04 · `TaxonomyVersion` lifecycle & publication

| Criterion | Status | Test |
|---|---|---|
| States draft/published/superseded; only draft→published and published→superseded legal | ✅ | `api/…/domain/taxonomy-lifecycle.spec.ts` › has exactly three states; permits draft → published; permits published → superseded; rejects every transition that is not draft→published or published→superseded (7 illegal pairs) |
| Publication runs all M1-03 invariants and fails atomically | ✅ | `api/…/domain/taxonomy-version-publication.spec.ts` › publication preconditions › blocks publication when an invariant is violated and leaves the version a draft |
| A published version rejects every mutation with a typed error | ✅ | same file › post-publication immutability › rejects {addConceptNode, moveConceptNode, removeConceptNode, addPrerequisiteEdge, removePrerequisiteEdge} on a published version (5 cases) and on a superseded version (5 cases) |
| Publication stamps `publishedAt` and the publishing `PrincipalRef` | ✅ | same file › moves draft → published and stamps time and principal |
| A concept cannot be removed while referenced | ✅ | same file › refuses to remove a concept that a prerequisite edge still references |
| *(tests)* invariant failure leaves state unchanged | ✅ | same file › blocks publication when an invariant is violated and leaves the version a draft (asserts state and `publishedAt`) |

### M1-05 · `NumericAnswerSpec`

| Criterion | Status | Test |
|---|---|---|
| All five comparison modes representable | ✅ | `api/…/domain/value-objects/numeric-answer-spec.spec.ts` › comparison modes › represents all five modes; constructs a valid {EXACT, ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE, SIGNIFICANT_FIGURES, RANGE} spec |
| ABSOLUTE/RELATIVE require `toleranceValue` | ✅ | same file › mode-required parameters › rejects ABSOLUTE_TOLERANCE without toleranceValue; …RELATIVE_TOLERANCE… |
| SIGNIFICANT_FIGURES requires `significantFigures` | ✅ | same file › rejects SIGNIFICANT_FIGURES without significantFigures |
| RANGE requires both bounds with min ≤ max | ✅ | same file › rejects RANGE missing both bounds/only rangeMin/only rangeMax; rejects rangeMin greater than rangeMax; accepts rangeMin equal to rangeMax |
| `UnitSpec` with canonical, equivalents, `required` | ✅ | same file › unit › carries canonical form, accepted equivalents and the required flag |
| `acceptedForms` non-empty subset | ✅ | same file › accepted forms › rejects an empty set; accepts any non-empty subset; rejects a repeated form; rejects an unknown form |
| Normalization flags all present with defaults | ✅ | same file › normalization flags › applies all four defaults when none are supplied; keeps every flag present when one is overridden |
| Missing a mode-required parameter is a construction error | ✅ | same file › all mode-required-parameter cases above return `Result` errors, not throws |
| *(tests)* immutability | ✅ | same file › immutability › freezes the spec, its unit, its forms and its flags; rejects reassignment of a field; does not share the caller's arrays |

### M1-06 · `TimingPolicy` & `NavigationPolicy`

| Criterion | Status | Test |
|---|---|---|
| `TimingPolicy` fields; duration > 0 | ✅ | `api/…/domain/value-objects/delivery-policies.spec.ts` › TimingPolicy › carries duration, locking, thresholds and auto-submit; rejects total duration 0/−1/NaN/Infinity |
| `warningThresholdsMinutes` descending, all < total | ✅ | same file › rejects thresholds that are not strictly descending (3 cases); rejects threshold 180/181 that is not before the end |
| `NavigationPolicy` four flags | ✅ | same file › NavigationPolicy › carries all four navigation flags |
| `sectionLocking=true` with `crossSectionNavigation=true` rejected | ✅ | same file › delivery policy compatibility › rejects section locking combined with cross-section navigation |
| Both immutable | ✅ | same file › TimingPolicy › is immutable; does not share the caller's threshold array; NavigationPolicy › is immutable |

### M1-07 · `MarkingRuleSet` schema & structural validation

| Criterion | Status | Test |
|---|---|---|
| All eight conditions representable | ✅ | `api/…/domain/value-objects/marking-rule-set.spec.ts` › conditions › covers all eight condition kinds; constructs $kind (8 cases); carries the parameters of PARTIAL_CORRECT_SELECTED; …of MATCHING_PAIRS_CORRECT |
| All three awards representable | ✅ | same file › awards › covers all three award kinds; constructs $kind (3 cases) |
| A rule set must terminate in an `ALWAYS` rule (F46) | ✅ | same file › MarkingRuleSet structure › rejects a set that does not terminate in ALWAYS |
| Rule IDs unique within the set | ✅ | same file › rejects a duplicate rule id |
| Rules ordered; order preserved and significant | ✅ | same file › MarkingRuleSet ordering › preserves rule order through a serialization round-trip; treats order as significant — a reordered set is a different set |
| `schemaVersion` mandatory | ✅ | same file › requires a schema version |
| Unreachable condition produces a warning, not an error | ✅ | same file › MarkingRuleSet unreachable rules › warns, rather than failing, when an earlier rule subsumes a later one; warns when a stricter partial-credit rule sits behind a wider one; two negative cases |
| *(tests)* `ALWAYS` not last rejected | ✅ | same file › rejects an ALWAYS rule that is not last |
| *(tests)* JEE Main set validates | ✅ | same file › validates the JEE Main set: three authored rules plus a terminal ALWAYS |
| *(tests)* JEE Advanced 7-rule set validates | ✅ | same file › validates the JEE Advanced seven-rule set with zero structural change |
| `aggregation: AggregationSpec` (ASSESSMENT-ENGINE §2.1) | ❌ | **Finding A-1.** Not modelled. `AggregationSpec` is named in §2.1 but defined nowhere in the document set, and is absent from M1-07's acceptance list. Deferred to M2, which owns score aggregation. |

### M1-08 · `MarkingRuleSet` canonical hashing

| Criterion | Status | Test |
|---|---|---|
| Hash over a canonical serialization (keys sorted, no whitespace, explicit numeric formatting) | ✅ | `api/…/domain/value-objects/marking-rule-set-hash.spec.ts` › canonical serialization › sorts keys, emits no whitespace and formats numbers explicitly |
| Semantically identical sets hash equal regardless of construction path | ✅ | same file › hash stability › is identical across 1,000 shuffled constructions; is identical for a set rebuilt from its own serialized data; ignores the order in which item types were listed |
| Any semantic change changes the hash | ✅ | same file › hash sensitivity › changes when {a mark value, an award kind, a rule id, an item type, a section scope, a condition kind} changes; …when a condition parameter changes; …when noIncorrect flips; …when a matching-pair count changes; does not confuse marks 4 with marks −4; does not confuse a section-scoped rule with an unscoped one |
| Reordering rules changes the hash | ✅ | same file › changes when the rule order changes |
| Hash incorporates `schemaVersion` | ✅ | same file › changes when the schema version changes |
| Hash stable across process restarts and library versions | ✅ | same file › matches the committed golden fixture for the JEE Main set; …for the JEE Advanced set (fixtures were computed in an earlier process; a change of behaviour breaks them) |
| *(tests)* golden hash fixtures committed and asserted | ✅ | `api/src/testing/golden/marking-rule-set-hashes.json` asserted by the two tests above and by `seed/data/jee-main-2026.profile.spec.ts` › matches the committed golden marking-rule-set hash |

### M1-09 · `SectionSpec` & blueprint consistency

| Criterion | Status | Test |
|---|---|---|
| Carries ordinal, name, subject, itemCount, itemTypeMix, maxMarks, sectionTiming? | ✅ | `api/…/domain/section-spec.spec.ts` › SectionSpec › carries ordinal, name, subject, counts, mix, marks and optional timing |
| Ordinals contiguous from 1, no gaps or duplicates | ✅ | same file › blueprint consistency › rejects a gap in the ordinals; rejects duplicate ordinals; accepts sections supplied out of order as long as the ordinals are contiguous |
| `itemTypeMix` counts sum exactly to `itemCount` | ✅ | same file › rejects an item type mix that does not sum to the item count; accepts a mix that sums exactly, including a zero-count type |
| Sum of section `maxMarks` equals the profile total | ✅ | same file › rejects section marks that do not sum to the profile total |
| `sectionTiming` present only when `sectionLocking` is true | ✅ | same file › rejects section timing when the profile does not lock sections; requires section timing on every section when the profile locks sections; accepts locked sections when every section is timed |

### M1-10 · `Exam` aggregate

| Criterion | Status | Test |
|---|---|---|
| Carries `examId`, `code`, `displayName`, `jurisdiction`, `conductingBody` | ✅ | `api/…/domain/exam.spec.ts` › Exam construction › carries id, code, display name, jurisdiction and conducting body |
| `code` unique | ✅ | Enforced at the database: `api/…/infrastructure/curriculum-schema.integration.spec.ts` › referential integrity › rejects a duplicate exam code within a tenant |
| Tracks active profile versions by academic year | ✅ | `exam.spec.ts` › Exam active profile versions › tracks one active version per academic year |
| At most one active profile version per academic year; a second is rejected | ✅ | same file › rejects a second activation for the same year; allows a successor after the year is deactivated. Enforced at the database: `curriculum-schema.integration.spec.ts` › permits at most one active profile version per exam and academic year |
| `code` immutable after creation | ✅ | `exam.spec.ts` › Exam code immutability › rejects reassignment of the code; keeps the code across activations |

### M1-11 · `ExamProfileVersion` & publication preconditions

| Criterion | Status | Test |
|---|---|---|
| Composes sections, policies, rule set, tolerance, allowances, taxonomy reference | ✅ | `api/…/domain/exam-profile-version.spec.ts` › composition › composes sections, policies, marking, tolerance, allowances and taxonomy reference |
| States draft/published/superseded | ✅ | same file › publication › moves published → superseded and rejects every other transition |
| Precondition: blueprint arithmetic consistent | ✅ | same file › publication preconditions › blocks publication when the blueprint arithmetic is inconsistent; …when section ordinals are not contiguous |
| Precondition: rule set valid and `ALWAYS`-terminated | ✅ | Enforced at construction — `MarkingRuleSet.create` rejects the set before a profile can hold it: `marking-rule-set.spec.ts` › rejects a set that does not terminate in ALWAYS; at the application boundary: `api/…/application/handlers/exam-profile-handlers.integration.spec.ts` › rejects a draft whose marking rule set has no terminal ALWAYS |
| Precondition: every `itemTypeAllowance` has a matching marking rule | ✅ | `exam-profile-version.spec.ts` › blocks publication when an allowed item type has no matching marking rule |
| Precondition: referenced `taxonomyVersionId` is published | ✅ | same file › blocks publication when the referenced taxonomy version is not published |
| Precondition: `goldenSetValidation` field present | ✅ | same file › always carries a goldenSetValidation field, defaulted to not_run; `api/…/m2-seam.integration.spec.ts` › seam 4 |
| Published versions reject all mutation | ✅ | same file › immutability after publication › rejects {replaceSections, replaceMarkingRuleSet, replaceItemTypeAllowances, recordGoldenSetValidation} on a published profile (4) and on a superseded profile (4) |
| `markingRuleSetHash` computed and frozen at publication | ✅ | same file › freezes the marking rule set hash at publication |
| *(tests)* each precondition failure blocks publication independently | ✅ | same file › five separate precondition tests, each asserting the state is unchanged |
| *(tests)* JEE Main 2026 profile publishes | ✅ | `seed/data/jee-main-2026.profile.spec.ts` › loading and publishing › publishes with every precondition satisfied |
| *(tests)* JEE Advanced-shaped profile publishes with zero code change | ✅ | `exam-profile-version.spec.ts` › EXT-01 › publishes a JEE Advanced-shaped profile with the seven-rule set and no code change |

### M1-12 · `TaxonomyMigration` mapping model

| Criterion | Status | Test |
|---|---|---|
| Mapping kinds IDENTITY/RENAME/MOVE/SPLIT/MERGE/REMOVAL | ✅ | `api/…/domain/taxonomy-migration.spec.ts` › TaxonomyMapping kinds › supports all six kinds; constructs a valid $kind mapping (6 cases) |
| Cardinality enforced per kind | ✅ | same file › TaxonomyMapping cardinality › 9 rejection cases across all six kinds; accepts a SPLIT into three concepts |
| Every mapping references concept identities in the correct version | ✅ | same file › TaxonomyMigration mapping references › rejects a source concept absent from the source version; rejects a target concept absent from the target version |
| A concept may appear in at most one mapping per migration | ✅ | same file › rejects a concept that already appears in another mapping; rejects a concept re-used as a target of a second mapping |

### M1-13 · Migration exception derivation & dry-run

| Criterion | Status | Test |
|---|---|---|
| IDENTITY and RENAME migrate automatically | ✅ | `api/…/domain/migration-dry-run.spec.ts` › dry run classification › yields zero exceptions when every mapping is IDENTITY or RENAME |
| MOVE/SPLIT/MERGE/REMOVAL always produce exceptions | ✅ | same file › raises an exception for MOVE/SPLIT/MERGE/REMOVAL (4 cases) |
| Unmapped source concept produces an `UNMAPPED` exception | ✅ | same file › reports a source concept with no mapping as UNMAPPED; does not report target-only concepts as unmapped |
| Output lists auto-migratable count, exceptions with kind and concepts, invalid mappings | ✅ | same file › lists the auto-migratable count, exceptions and the version pair; names the affected concepts on every exception; dry run invalid mappings › reports a mapping that references a concept absent from its version |
| Dry-run performs no mutation | ✅ | same file › dry run purity › mutates nothing observable on the migration |
| Result deterministic and reproducible | ✅ | same file › is deterministic across 100 runs; is independent of the order the same mappings were added in |

---

## Track B — Persistence

### M1-14 · Curriculum schema migration

| Criterion | Status | Test |
|---|---|---|
| Nine named tables in the `curriculum` schema | ✅ | `api/…/infrastructure/curriculum-schema.integration.spec.ts` › curriculum migration › applies to a clean database and creates all nine tables |
| No foreign key crosses a schema boundary (F2) | ✅ | same file › fitness function F2 › finds no cross-schema foreign key anywhere in the database; has foreign keys inside the curriculum schema |
| UUIDv7 primary keys (P6) | ✅ | same file › generates time-ordered UUIDv7 keys |
| `tenant_id` on tenancy-scoped tables (P7) | ✅ | same file › defaults tenant_id to the platform tenant on every tenancy-scoped table |
| Every JSONB column has a sibling `*_schema_version` (F5) | ✅ | same file › fitness function F5 › finds no JSONB column without a `*_schema_version` sibling; covers the four policy columns named in the task |
| `marking_rule_set_hash` stored alongside the JSONB | ✅ | same file › fitness F5 covers the column; `m2-seam.integration.spec.ts` › seam 2 › stores the schema version alongside the JSONB |
| Migration reversible; down-migration verified | ✅ | same file › reverses cleanly and re-applies. Also run by hand in the close-out (see M1-CLOSEOUT.md Part 1) |
| FK constraints enforced | ✅ | same file › referential integrity › 6 rejection cases |
| *(tests)* CI check for cross-schema FKs | ✅ | same file › fitness function F2 (a catalogue query, so it holds for the whole database) |
| *(tests)* CI check for JSONB sibling columns | ✅ | same file › fitness function F5 |

### M1-15 · Published-row immutability triggers

| Criterion | Status | Test |
|---|---|---|
| `BEFORE UPDATE` trigger on `taxonomy_version` rejects updates when `OLD.state = 'published'` | ✅ | `api/…/infrastructure/published-immutability.integration.spec.ts` › taxonomy_version publication immutability › rejects an update to a published version via raw SQL; …via the ORM |
| Same on `exam_profile_version` | ✅ | same file › exam_profile_version publication immutability › rejects an update to a published profile via raw SQL and via the ORM |
| Trigger permits `published → superseded` and nothing else | ✅ | same file › permits the published → superseded transition; rejects any other transition out of published; rejects a superseded → anything transition; rejects supersession that also changes another column |
| Cascading child tables reject mutation when the parent is published | ✅ | same file › child tables under a published parent › rejects an update to a concept node of a published version; rejects inserting or deleting a concept node under a published version; rejects a prerequisite edge change; rejects a section spec change |
| The trigger fires regardless of connection role — a direct `psql` update is rejected | ✅ | same file › the raw-SQL cases above use the `pg` driver directly, bypassing the ORM. Additionally verified from a `psql` shell in the close-out (M1-CLOSEOUT.md Part 1) |
| *(tests)* draft updates unaffected | ✅ | same file › leaves draft updates untouched; permits the draft → published transition; leaves draft profiles editable; leaves children of a draft parent editable |

### M1-16 · Taxonomy repositories

| Criterion | Status | Test |
|---|---|---|
| Full aggregate round-trip yields a domain-equal object | ✅ | `api/…/infrastructure/taxonomy-repositories.integration.spec.ts` › ConceptIdentity repository › round-trips an identity to a domain-equal object; …a superseded identity; TaxonomyVersion repository round-trip › restores nodes, parent links, depths and edges |
| Loading a version reconstitutes all nodes and edges with correct parent links | ✅ | same file › restores nodes, parent links, depths and edges |
| Optimistic concurrency via `aggregate_version`; stale write raises `Conflict` | ✅ | same file › raises Conflict on a stale write (identity); TaxonomyVersion repository concurrency › raises Conflict when two writers update the same version |
| `snake_case` ↔ `camelCase` mapping happens here and nowhere else | ✅ | `api/…/infrastructure/row-mapping.spec.ts` › 15 mapping tests; F1/F2 boundary check confirms no other layer imports the schema |
| No domain type imports the ORM | ✅ | `api/src/fitness/boundary-rules.spec.ts` › F2 › finds no violation in the shipped domain (+ planted evasion cases) |
| *(tests)* round-trip equality on a 600-node version | ✅ | `taxonomy-repositories.integration.spec.ts` › round-trips a 600-node version to a domain-equal object |
| *(tests)* partial-load rejection | ✅ | same file › TaxonomyVersion partial load rejection › rejects a version whose node parent is not among the loaded nodes; …whose prerequisite endpoint is not placed in it; …a node row whose stored weight is out of range |

### M1-17 · Exam profile repositories

| Criterion | Status | Test |
|---|---|---|
| Round-trip preserves rule set semantics and hash exactly | ✅ | `api/…/infrastructure/exam-profile-repositories.integration.spec.ts` › round-trip › preserves rule set semantics and the hash exactly; `m2-seam.integration.spec.ts` › seam 2 |
| JSONB validated against the registered schema on write; invalid JSONB rejected before the database | ✅ | `exam-profile-repositories.integration.spec.ts` › JSONB validation before the write › accepts the payload a real profile serializes to; rejects invalid {marking_rule_set ×2, timing_policy, tolerance_defaults, item_type_allowances, golden_set_validation}; writes nothing when a rule set without a terminal ALWAYS is offered |
| Section specs load in ordinal order | ✅ | same file › loads section specs in ordinal order however they were written |
| Optimistic concurrency enforced | ✅ | same file › concurrency › raises Conflict when two writers update the same draft; Exam repository › raises Conflict on a stale exam write |

### M1-18 · Migration repository

| Criterion | Status | Test |
|---|---|---|
| Round-trip preserves mapping kinds and cardinality | ✅ | `api/…/infrastructure/taxonomy-migration.repository.integration.spec.ts` › round-trip › preserves mapping kinds, cardinality and order; round-trips every mapping kind; preserves dispositions |
| Dry-run result persisted as JSONB with a schema version | ✅ | same file › dry-run persistence › stores the dry-run result as JSONB with its schema version; leaves the dry-run result null until one is run |
| A migration in `executing` state cannot be modified | ✅ | same file › state guard › refuses to modify a migration that is executing; permits the move out of executing to executed |

---

## Track C — Application

### M1-19 · Taxonomy commands & handlers

| Criterion | Status | Test |
|---|---|---|
| Six commands present | ✅ | `api/…/application/handlers/taxonomy-handlers.spec.ts` › handler registry › registers all six taxonomy handlers |
| Every handler declares a policy; the module fails to boot without one (F36) | ✅ | same file › fails to boot when a handler declares no policy; …an empty policy; …on a duplicate handler name. **Module level:** `api/…/api/curriculum.module.spec.ts` › F36 › throws when a handler declares no policy at all; …a policy that permits nobody; builds no controller when registration fails |
| Exactly one aggregate mutated per transaction | ✅ | `api/…/application/handlers/taxonomy-handlers.integration.spec.ts` › mutates exactly one aggregate per command |
| Handlers return typed results; no throw on domain failure | ✅ | `taxonomy-handlers.spec.ts` › rejects an invalid draft without writing anything; reports invariant violations from a failed publication and writes nothing (both assert a `Result` error) |
| Every mutation writes an `AuditRecord` with `PrincipalRef` | ✅ | `taxonomy-handlers.spec.ts` › creates a draft and audits it (asserts principal, action, target, correlation id); adds a root and a child node, auditing each; moves a node and audits it |
| *(tests)* unit with in-memory repository | ✅ | `taxonomy-handlers.spec.ts` (21 tests against `InMemory*Repository`) |
| *(tests)* integration transaction boundary | ✅ | `taxonomy-handlers.integration.spec.ts` › leaves no partial write when the domain rejects the change; rolls the whole child rewrite back when the update transaction fails |
| *(tests)* authorization negative path per handler, 100% | ✅ | `taxonomy-handlers.spec.ts` › denies every handler to a principal without the role (all 6 handlers); denies publication to a curator who is not content ops; denies publication without step-up; checks authorization before touching the repository |
| *(tests)* audit record written | ✅ | as above |

### M1-20 · Exam profile commands & handlers

| Criterion | Status | Test |
|---|---|---|
| Five commands present | ✅ | `api/…/application/handlers/exam-profile-handlers.integration.spec.ts` › registry › registers all five commands with a policy each |
| Publication atomic: all preconditions evaluated before any write | ✅ | same file › publication preconditions leave no partial write › blocks publication when the blueprint arithmetic is wrong; …when the taxonomy version is still a draft; …when an allowed item type has no marking rule; rejects a second active version for the same academic year (each asserts stored state and `aggregateVersion` unchanged) |
| Publishing requires step-up authorization | ✅ | same file › authorization negative paths › requires step-up to publish; requires step-up to supersede; requires step-up on publication and supersession only |
| *(tests)* authorization negative path per handler | ✅ | same file › denies every command to a principal without the role (all 5) |
| *(tests)* precondition failure leaves no partial write | ✅ | as above |

### M1-21 · Migration commands & handlers

| Criterion | Status | Test |
|---|---|---|
| Four commands present | ✅ | `api/…/application/handlers/migration-handlers.integration.spec.ts` › registry › registers all four commands with a policy each |
| `ExecuteMigration` rejected unless a dry-run exists | ✅ | same file › execution gate › rejects execution before any dry run |
| …and every exception is dispositioned | ✅ | same file › rejects execution while an exception is undispositioned; executes once every concept is mapped and every exception dispositioned |
| Execution requires step-up authorization | ✅ | same file › requires step-up to execute; denies execution to a curator who is not content ops |
| Execution chunked and resumable; never one long transaction | ✅ | same file › chunked, resumable execution › never migrates more than one chunk at a time; resumes after an interruption without redoing finished work; refuses to modify a migration that is executing |

### M1-22 · Curriculum queries

| Criterion | Status | Test |
|---|---|---|
| Seven queries present | ✅ | `api/…/application/queries/curriculum-queries.integration.spec.ts` › query registry › registers all seven queries, each with a policy |
| Each declares an authorization policy | ✅ | same file (asserts `allowedRoles.length > 0` for each) |
| `GetConceptSubtree` supports depth limiting | ✅ | same file › subtree query › returns the whole subtree by default; limits depth when asked; returns only the root at depth limit 0; can start from a node that is not the root |
| Read models are DTOs, never domain aggregates | ✅ | same file › projects a version as a DTO, not an aggregate (asserts a JSON round-trip equals the view); projects a profile with its sections in ordinal order |
| *(tests)* projection correctness | ✅ | same file › taxonomy queries, prerequisite query, exam profile queries, migration dry-run query |
| *(tests)* authorization negative paths | ✅ | same file › denies every query to a principal with no curriculum role (all 7); denies the migration dry run to a learner but allows the taxonomy read |

### M1-23 · Public barrel & boundary enforcement

| Criterion | Status | Test |
|---|---|---|
| Exports exactly three categories: commands, queries, events | ✅ | `api/src/fitness/boundary-rules.spec.ts` › public barrel surface › re-exports commands, queries and events only from the layers that own them |
| No domain aggregate, entity, repository or infrastructure type exported | ✅ | same file › exports only the three value-level symbols it means to; exports no aggregate, entity, repository or infrastructure class |
| Another module importing outside the barrel fails CI (F1) | ✅ | same file › F1 › finds no violation in the shipped source; fires on a planted violation |
| Value objects exported as read-only DTOs, not domain types | ✅ | same file › exposes the marking rule set and answer spec as data, not as domain classes; `m2-seam.integration.spec.ts` › seam 1 |
| *(tests)* dependency-cruiser rule with a planted violation | ✅ | Implemented as an in-repo checker (ADR-0002). Parity proven: same file › detects the non-static form (4 cases); catches a domain module evading the rule by dynamic import or require |
| *(tests)* barrel surface snapshot | ✅ | same file › exports only the three value-level symbols it means to |

### M1-24 · Domain events & outbox emission

| Criterion | Status | Test |
|---|---|---|
| Three events defined | ✅ | `api/…/infrastructure/outbox-emitter.integration.spec.ts` › event registry › declares the three curriculum events |
| Each written to `outbox_message` in the same transaction as the aggregate change (P4) | ✅ | same file › outbox atomicity › commits the aggregate change and the event together; rolls both back when the event write fails; rolls the event back when the aggregate write fails |
| Event payloads carry IDs only, never full aggregates | ✅ | same file › event payloads › carries identifiers only, never a nested aggregate |
| Each event has a registered analytics counterpart or an explicit exemption (F18) | ✅ | same file › gives every event an analytics counterpart or an explicit exemption (F18); names analytics events as domain.object_past_verb |
| *(tests)* payload shape assertion | ✅ | same file › stores the event with its type, schema version, principal and correlation id |
| *(tests)* CI event registry completeness | ✅ | same file › F18 test above iterates the registry against `CURRICULUM_EVENT_TYPES` |

---

## Track D — API

### M1-25 · OpenAPI contract & generated types

| Criterion | Status | Test |
|---|---|---|
| Every command and query has a documented operation | ✅ | `api/src/contracts/curriculum-contract.spec.ts` › F15 › maps every registered handler to exactly one operation; names no handler the application layer does not register; covers all fifteen commands and all seven queries |
| Cursor pagination on all list endpoints; no offset parameters | ✅ | same file › pagination › offers cursor pagination on every list endpoint; declares no offset parameter anywhere; returns a page envelope with pageInfo from every list endpoint |
| Filter and sort fields allowlisted per endpoint | ✅ | same file › allowlisted filter and sort fields › constrains every sort parameter to an enum; constrains enumerable filters to an enum; declares no free-form filter parameter |
| RFC 9457 error schema with the closed error-code set | ✅ | same file › RFC 9457 problem details › declares the closed error-code taxonomy; requires code, retryable and correlationId on every problem; serves errors as application/problem+json |
| `camelCase` JSON throughout | ✅ | same file › camelCase JSON › names every schema property in camelCase; leaks no snake_case anywhere in the document |
| Types generate cleanly for TypeScript clients | ✅ | same file › generated types › compiles and models the problem details shape; models a cursor-paginated list response. Plus `pnpm typecheck` over the generated `packages/contracts/src/curriculum.ts` |
| *(tests)* spec validates against OpenAPI 3.1 | ⚠️ | **Finding D-1.** The spec asserts `openapi === '3.1.0'` and structural properties, but is not run through an OpenAPI 3.1 schema validator. Structure is checked by hand-written assertions, not by the standard. |

### M1-26 · Curriculum controllers

| Criterion | Status | Test |
|---|---|---|
| Controllers contain zero business logic | ✅ | `api/…/api/curriculum.controller.integration.spec.ts` › controllers hold no business logic › constructs no domain object and touches no repository |
| Request DTOs validated by Zod schemas | ✅ | same file › error mapping › returns 400 with field detail for a malformed body; rejects an unknown field rather than ignoring it |
| Domain errors map to the correct HTTP status and `code` | ✅ | same file › returns 401/403/404/409/422 with the matching `code` (5 tests) |
| ETag / `If-Match` on mutating endpoints, mapped to `aggregate_version` | ✅ | same file › creates a taxonomy draft and returns 201 with an ETag; adds a concept node through If-Match; returns 409 on a stale If-Match; returns 428 when If-Match is missing |
| `Idempotency-Key` accepted on publish operations | ✅ | same file › publishes a taxonomy version with an idempotency key; returns 400 when the Idempotency-Key is missing on publication |
| Correlation ID present in every response, including errors | ✅ | same file › echoes the caller's correlation id on success and on failure |
| *(tests)* each endpoint happy path | ⚠️ | **Finding D-2.** 6 of 22 operations have an explicit happy-path test (create/read/list taxonomy, create exam, publish, create+read profile). The remaining 16 share the same translation path, which is tested, but are not individually exercised. |
| *(tests)* contract tests green | ⚠️ | **Finding D-3.** Contract tests validate the spec document (M1-25); no consumer-driven contract test runs the spec against the live controller. |
| *(tests)* malformed DTO returns 400 with field detail | ✅ | same file › returns 400 with field detail for a malformed body |
| *(tests)* concurrency conflict returns 409 | ✅ | same file › returns 409 on a stale If-Match |

---

## Track E — Content & Data

### M1-27 · Taxonomy import format & loader

| Criterion | Status | Test |
|---|---|---|
| Format is YAML with a declared schema version | ✅ | `seed/taxonomy-loader.spec.ts` › schema validation › accepts a well-formed file; rejects a file declaring an unsupported schema version |
| Loader validates the entire file before writing anything | ✅ | same file › loading › writes nothing when the file is invalid — all or nothing |
| Per-record errors reported with file location | ✅ | same file › reports a malformed document with a line number; reports a per-record location, not just "invalid" (asserts path `/subjects/0/root/examWeight` and line 9) |
| Loading is idempotent | ✅ | same file › is idempotent: re-running the same file changes nothing |
| Loader produces a draft version, never a published one | ✅ | same file › never produces a published version |
| *(tests)* schema validation with fixture files | ✅ | same file › 7 validation tests over 6 fixtures |
| *(tests)* 600-node load | ✅ | same file › loads a 600-node taxonomy |

### M1-28 · JEE Main 2026 taxonomy dataset

| Criterion | Status | Test |
|---|---|---|
| ~600 concepts across Physics, Chemistry, Mathematics | ✅ | `seed/data/jee-main-2026.taxonomy.spec.ts` › dataset shape › holds roughly 600 concepts (608); covers Physics, Chemistry and Mathematics |
| Hierarchy matches the official NTA syllabus structure | ⚠️ | **Finding E-1.** Tested structurally — › follows the NTA syllabus structure: subject, chapter, topic; names the chapters the syllabus names — but fidelity to the published syllabus is a subject-matter judgement no test can make. |
| `examWeight` per chapter, summing to 1.0 per subject | ✅ | same file › exam weights › sums chapter weights to 1.0 for physics/chemistry/mathematics; gives every chapter a positive weight; keeps every weight inside [0, 1] |
| Prerequisite edges present for genuinely dependent concepts, acyclic | ✅ | same file › prerequisites › declares genuine cross-chapter dependencies; references only concepts the file defines; loading and publishing › has an acyclic prerequisite graph, proven by the aggregate accepting every edge |
| Passes M1-27 validation and publishes cleanly under M1-04 | ✅ | same file › passes M1-27 validation; loads and passes the whole invariant suite; publishes cleanly under M1-04 |
| **Subject-matter reviewed and signed off before merge** | ❌ | **Finding E-2.** Not done and not testable. The file header carries `STATUS: awaiting subject-matter review and sign-off`, asserted by › review status › records that subject-matter sign-off is still outstanding. Needs a human SME. |

### M1-29 · JEE Main 2026 exam profile

| Criterion | Status | Test |
|---|---|---|
| 3 sections, 25 items each, 20 MCQ + 5 numeric | ✅ | `seed/data/jee-main-2026.profile.spec.ts` › shape › declares three sections of 25 items, 20 MCQ and 5 numeric |
| 300 marks; 180-minute single timer; `sectionLocking: false`; free navigation | ✅ | same file › adds up: 75 items, 300 marks, 100 per section; runs a single 180-minute timer with free navigation |
| Marking rule set is the JEE Main set from ASSESSMENT-ENGINE §2.4 | ✅ | same file › uses the JEE Main marking set, ALWAYS-terminated; never penalises an unanticipated response state |
| Tolerance defaults present for numeric items | ✅ | same file › provides tolerance defaults for numeric items |
| Publishes with every precondition satisfied | ✅ | same file › loading and publishing › publishes with every precondition satisfied; refuses to publish before the taxonomy is published |
| *(tests)* hash matches the committed golden fixture | ✅ | same file › matches the committed golden marking-rule-set hash |

### M1-30 · NEET UG exam profile — the EXT-01 proof

| Criterion | Status | Test |
|---|---|---|
| 180 items (45/45/90), 720 marks, 200 minutes | ✅ | `seed/data/neet-ug-2026.profile.spec.ts` › shape › declares 180 items: Physics 45, Chemistry 45, Biology 90; totals 720 marks over 200 minutes |
| Single-correct MCQ only; same marking set, different section structure | ✅ | same file › permits single-correct MCQ only; carries the same marking set as JEE Main, ALWAYS-terminated |
| Publishes successfully | ✅ | same file › EXT-01 › publishes successfully |
| Zero changes outside `tools/seed/data/` — asserted by a diff check in CI | ✅ | same file › touches only files under tools/seed/data (`git diff --name-only` over the NEET commit range); changes no application, domain or infrastructure code |
| Zero schema migrations required | ✅ | same file › requires no schema migration; reuses the exact tables JEE Main uses |

### M1-31 · Local seed integration

| Criterion | Status | Test |
|---|---|---|
| One command loads and publishes both taxonomies and all profiles | ✅ | `seed/index.spec.ts` › pnpm seed › loads and publishes both taxonomies and both profiles on a clean database; publishes everything it loads |
| Completes in ≤ 60 seconds on a clean database | ✅ | same file › completes within the 60-second budget. Measured at 0.3 s by hand (M1-CLOSEOUT.md Part 1) |
| Idempotent — safe to re-run | ✅ | same file › is idempotent: a second run changes nothing |
| Included in the Compose boot verification (F8) | ❌ | **Finding E-3.** Blocked by M0 — no Compose stack exists. See ADR-0004. |

---

## Track F — Studio

### M1-32 · Studio taxonomy browser

| Criterion | Status | Test |
|---|---|---|
| Version selector | ✅ | `studio/…/taxonomy/TaxonomyBrowser.spec.tsx` › version selector › lists the versions of the exam family and selects the first; loads the newly selected version |
| Tree view with lazy-loaded subtrees | ✅ | same file › tree rendering and expansion › renders roots expanded and deeper levels collapsed; expands a subtree on demand and collapses it again; offers no expand control for a leaf |
| Concept detail: identity, weight, prerequisites, item count (stubbed) | ✅ | same file › concept detail › shows identity, weight, depth and prerequisites for the selected concept; stubs the item count until content authoring ships |
| Search within a version | ✅ | same file › search › finds a concept anywhere in the version, including collapsed branches; reports an empty result set rather than showing nothing; selects a concept straight from the results |
| Published versions visibly read-only | ✅ | same file › marks a published version as read-only; shows no read-only notice for a draft |
| Loads a 600-node tree with p95 interaction < 200 ms | ⚠️ | **Finding F-1.** › performance budget › renders a 600-node version and expands a branch well inside 200 ms measures a *single* interaction in jsdom, not p95 in a browser. Directionally useful, not a p95 measurement. |
| *(tests)* component: tree rendering and expansion | ✅ | as above |
| *(tests)* E2E: navigate to a concept and view detail | ❌ | **Finding F-2.** No Playwright E2E. Requires an assembled Studio app (shell, router, 1280 px gate), which M1 does not build. |
| *(tests)* accessibility scan clean | ✅ | same file › accessibility › passes the automated WCAG 2.2 AA scan; passes the scan with a concept selected and a branch expanded; is fully keyboard operable |

### M1-33 · Studio taxonomy draft editor

| Criterion | Status | Test |
|---|---|---|
| Create draft from scratch or by cloning a published version | ✅ | `studio/…/taxonomy-editor/TaxonomyDraftEditor.spec.tsx` › creating a draft › creates an empty draft from scratch; creates a draft by cloning a published version |
| Add, rename, move, remove concepts; add prerequisite edges | ✅ | same file › edit operations › adds a concept; adds a child under the selected concept; renames a concept; removes a concept; moves a concept under a new parent; adds a prerequisite edge |
| Invariant violations surface inline and immediately | ✅ | same file › invariant violations surface inline › blocks a move that would put a concept inside its own subtree; reports a prerequisite cycle as soon as it is drawn; reports a self-prerequisite; announces problems politely. Rules unit-tested: › editing rules › detects a move into a descendant; detects a duplicate concept identity; detects an orphan |
| Publish action shows every unmet precondition before enabling | ✅ | same file › publication › shows every unmet precondition and keeps publish disabled; enables publish once every precondition is met |
| Optimistic concurrency: a stale edit shows a clear conflict, never a silent overwrite | ✅ | same file › optimistic concurrency › shows a clear conflict rather than overwriting silently; advances the aggregate version on a successful save |
| Fully keyboard-operable | ✅ | same file › accessibility › is fully keyboard operable |
| *(tests)* E2E: create draft → edit → publish → verify immutability | ❌ | **Finding F-2.** No Playwright E2E. Component-level equivalent: › publishes and then shows the version as read-only. |
| *(tests)* accessibility scan | ✅ | same file › passes the automated WCAG 2.2 AA scan; passes the scan with violations displayed |

### M1-34 · Studio exam profile viewer

| Criterion | Status | Test |
|---|---|---|
| Sections, timing, navigation, item-type allowances displayed | ✅ | `studio/…/exam-profile/ExamProfileViewer.spec.tsx` › profile display › shows sections in delivery order with their counts and marks; describes a single-timer profile as such; shows section timing when the profile locks sections; lists item type allowances and the sections they apply to |
| Marking rules rendered in evaluation order, in plain language | ✅ | same file › marking rules in plain language › renders the JEE Main set in evaluation order; renders the JEE Advanced partial-credit set in order; says that the first match wins; describes %j (6 condition cases); describes award %j (5 cases); reads a whole rule as one sentence |
| Rule-set hash shown and copyable | ✅ | same file › rule set hash › shows the hash; copies the hash on request; explains that a draft has no frozen hash yet |
| Published profiles visibly read-only | ✅ | same file › marks a published profile read-only; shows no read-only notice for a draft |
| *(tests)* component: rule rendering for both JEE Main and JEE Advanced sets | ✅ | as above |
| *(tests)* E2E: view profile | ❌ | **Finding F-2.** |
| *(tests)* accessibility scan | ✅ | same file › passes the automated WCAG 2.2 AA scan; passes the scan for the JEE Advanced rule set |

### M1-35 · Studio migration console

| Criterion | Status | Test |
|---|---|---|
| Select source and target versions; define mappings | ✅ | `studio/…/taxonomy-migration/MigrationConsole.spec.tsx` › selecting versions › creates a migration between two versions; refuses a migration from a version to itself; refuses a migration with a version unchosen |
| Dry-run results displayed before execution is offered | ✅ | same file › dry run results are shown before execution is offered › offers no execute section until a dry run has been run; shows the auto-migratable count and the exception count; lists every exception with its kind, concepts and reason; warns when a mapping has gone stale |
| Every exception requires explicit disposition before execute is enabled | ✅ | same file › execution is gated › blocks execution while any exception is undecided; still blocks execution when only some exceptions are decided; records each disposition against the migration; does not execute while the gate is closed |
| Execute requires typed confirmation, not a button click | ✅ | same file › requires the typed confirmation, not just a click |
| Progress shown for chunked execution | ✅ | same file › chunked execution progress › shows progress and then completion; reports intermediate progress while chunks are running; disables execution once it has finished |
| *(tests)* component: exception list rendering and disposition | ✅ | as above |
| *(tests)* E2E: full dry-run → disposition → execute flow | ⚠️ | **Finding F-2.** Covered at component level — › the full flow › runs dry run → disposition → execute end to end — but not as a browser E2E. |
| *(tests)* accessibility scan | ✅ | same file › passes the automated WCAG 2.2 AA scan with the exception list shown; passes the scan after execution |

---

## Findings summary

| # | Finding | Severity | Classification |
|---|---|---|---|
| A-1 | `AggregationSpec` (ASSESSMENT-ENGINE §2.1) not modelled | Low | Deferred to M2 — undefined in the document set, outside M1-07's acceptance list |
| D-1 | OpenAPI document not validated against the 3.1 meta-schema | Low | Debt |
| D-2 | 16 of 22 endpoints lack an individual happy-path test | Medium | Debt |
| D-3 | No consumer-driven contract test against the live controller | Medium | Deferred — needs a running app, which M0/M2 brings |
| E-1 | NTA syllabus fidelity tested structurally, not for content | Medium | Blocked on SME |
| E-2 | SME sign-off on the taxonomy datasets not obtained | High | Blocked on SME — release gate |
| E-3 | Compose boot verification (F8) for `pnpm seed` | Medium | Blocked by M0 |
| F-1 | "p95 < 200 ms" measured as a single jsdom interaction | Medium | Debt — needs browser instrumentation |
| F-2 | No Playwright E2E for any Studio surface | High | Deferred — needs an assembled Studio app |
