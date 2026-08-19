# M3 — Acceptance Criteria → Test Traceability

Every acceptance criterion in [M3-CONTENT-MODEL.md](M3-CONTENT-MODEL.md), mapped
to the test that proves it. Built by reading each criterion against the named
describe block, not by trusting a filename.

**Legend:** ✅ proven · ⚠️ partially proven, gap named · ❌ no test, or a test
that does not assert the criterion.

**Totals: 214 criteria · 205 ✅ · 9 ⚠️ · 0 ❌.**

Every ⚠️ is collected at the foot of this document with the debt item it maps to.
None of them is a criterion silently narrowed until it passed: where an approved
document could not be honoured, the divergence is stated in the spec that would
otherwise have claimed it.

Paths are relative to `apps/api/src/` unless prefixed. `›` separates a describe
block from the file it lives in.

---

## Track A — Content Domain

### M3-01 · Content context skeleton & error taxonomy
| Criterion | Test | |
|---|---|---|
| Five-directory anatomy | `contexts/content/context-anatomy.spec.ts` › the content context anatomy | ✅ |
| `Result` mirrors curriculum's and scoring's without importing either | `domain/result.spec.ts` › Result | ✅ |
| Error kinds drawn from the closed §8 taxonomy, narrowed to five | `domain/content-error.spec.ts` › the error taxonomy | ✅ |
| Zero `throw` anywhere under `domain/` | `domain/content-error.spec.ts` › the content domain layer | ✅ |
| Each guard proven against a planted violation | › the domain guards, run against a planted violation | ✅ |
| The guards read code, not prose | › the guards read code, not prose | ✅ |

### M3-02 · `ContentBody` — the closed node vocabulary
| Criterion | Test | |
|---|---|---|
| DEC-2's block and inline vocabulary, both closed `as const` | `domain/content-body.spec.ts` › the vocabulary | ✅ |
| `schemaVersion` carried on the document and is `1` | › the vocabulary | ✅ |
| Unknown block or inline kind rejected, never dropped | › the closed vocabulary refuses what it does not know | ✅ |
| `textAlternative` mandatory and non-blank on all four notation kinds | › notation requires an authored text alternative (ACC-02) | ✅ |
| No node carries rendered markup; no `html`/`rendered`/`svg` field exists | › rendered markup is refused (INV-14); › the vocabulary | ✅ |
| Empty document, empty paragraph and ragged table rejected | › structural validation | ✅ |
| Construction total and immutable | › immutability | ✅ |
| Every failure names a location | › failures name where the problem is | ✅ |

### M3-03 · `ContentBody` derived projections
| Criterion | Test | |
|---|---|---|
| `plainText` in reading order, notation as its alternative | `domain/content-body-projections.spec.ts` › plainText — reading order | ✅ |
| `notationTerms` normalized symbolic tokens | › notationTerms — the symbolic search field | ✅ |
| `referencedMediaIds` deduplicated, in document order | › referencedMediaIds — the usage graph's edge set | ✅ |
| Pure and deterministic, byte-identical on repeat | › projectContentBody | ✅ |
| Derived, never authored — no setter, no aggregate accepts one | › projections are derived, never authored | ✅ |

### M3-04 · `TaxonomyTag`
| Criterion | Test | |
|---|---|---|
| `{ conceptIdentityId, taxonomyVersionId, weight, isPrimary }` | `domain/taxonomy-tag.spec.ts` › a single tag | ✅ |
| Every tag names a `taxonomyVersionId` | › a single tag | ✅ |
| ≥ 1 tag, exactly one primary | › a tag set | ✅ |
| Weights in `[0, 1]`; duplicate concept rejected | › a single tag; › a tag set | ✅ |
| One taxonomy version per set | › a tag set | ✅ |
| Reading a validated set | › reading a validated set | ✅ |

### M3-05 · `Provenance`
| Criterion | Test | |
|---|---|---|
| Closed `sourceType` set | `domain/provenance.spec.ts` › the source-type vocabulary | ✅ |
| `previous_year` requires exam and year | › previous_year | ✅ |
| `licensed` requires an attribution reference | › licensed | ✅ |
| AI provenance requires all four generation fields | › AI provenance — half of what makes INV-01 auditable | ✅ |
| Unknown source type rejected, never coerced | › the source-type vocabulary | ✅ |
| Immutable once constructed; failures locate | › original; › failure locations | ✅ |

### M3-06 · `LicensingStatus`
| Criterion | Test | |
|---|---|---|
| Four statuses with optional ref, attribution, expiry | `domain/licensing-status.spec.ts` › the status vocabulary; › construction | ✅ |
| `licensed` requires both `licenseRef` and `attribution` | › construction | ✅ |
| `isPublishable` false for `unresolved` and for an expired licence | › isPublishable; › expiry | ✅ |
| Expiry supplied, boundary inclusive | › expiry | ✅ |
| Default for a new draft is `unresolved` | › the default for a new draft | ✅ |
| The block reason is stated, not inferred | › publicationBlockReason | ✅ |

### M3-07 · `ResponseSpecification`
| Criterion | Test | |
|---|---|---|
| `ITEM_TYPES` closed, four members | `domain/response-specification.spec.ts` › the item-type vocabulary | ✅ |
| Four variants constructible | › SINGLE_CORRECT_MCQ; › MULTIPLE_CORRECT_MCQ; › MATCHING; › NUMERIC | ✅ |
| An option body is a `ContentBody`, not a string | › an option body is ContentBody, not a string | ✅ |
| Ordinals contiguous; duplicate id rejected; MCQ ≥ 2 options | › SINGLE_CORRECT_MCQ | ✅ |
| Correct option and matching pair members must exist | › SINGLE_CORRECT_MCQ; › MULTIPLE_CORRECT_MCQ; › MATCHING | ✅ |
| Numeric mode parameters delegated to M3-08, not re-implemented | `application/answer-key-projection.spec.ts` › a specification the executor would refuse cannot be projected | ✅ |
| Immutable once constructed | › immutability | ✅ |

### M3-08 · Answer-key projection onto `scoring/public/`
| Criterion | Test | |
|---|---|---|
| `toAnswerKeyData(spec)` produces the shape the barrel names | `application/answer-key-projection.spec.ts` › projection produces a key the executor accepts | ✅ |
| Validated by `createAnswerKey`, not by a hand-written check | › a specification the executor would refuse cannot be projected | ✅ |
| Decimal literal crosses as text | › the authored decimal literal survives unchanged | ✅ |
| Normalization flags passed through as authored | › projection produces a key the executor accepts | ✅ |
| Item-type vocabularies asserted equal across the seam | › the item-type vocabularies agree across the seam | ✅ |
| The projection is one-way | › the projection is one-way | ✅ |
| An attempt is scored from a projected key using barrel exports alone | `contexts/scoring/m3-seam.spec.ts` | ✅ |
| Content reaches scoring only through the barrel | › the content context reaches scoring only through its barrel | ✅ |

### M3-09 · `ItemVersion`
| Criterion | Test | |
|---|---|---|
| Full field set, `authoredBy` a `PrincipalRef`, required | `domain/item-version.spec.ts` › construction | ✅ |
| `createdAt` supplied, never read from a clock | › the domain reads no clock | ✅ |
| `stimulusVersionRef` pins a version, not a stimulus | › stimulus association pins a version, not a stimulus | ✅ |
| `difficultyEstimate` in a documented band | › construction | ✅ |
| No mutator; `deriveDraft` produces the successor | › there is no mutator — an edit derives a successor | ✅ |
| Deeply immutable | › immutability | ✅ |
| Licensing defaults to `unresolved` when unstated | › licensing defaults to unresolved | ✅ |
| `localeVariants` deliberately absent until M3-16 | › localeVariants is modeled at M3-16, not half-shipped here | ✅ |

### M3-10 · `Item` — identity, versions, lifecycle
| Criterion | Test | |
|---|---|---|
| Full field set | `domain/item.spec.ts` › creation; › reconstitution | ✅ |
| Seven states and every legal transition | `domain/item-lifecycle.spec.ts` › the vocabulary | ✅ |
| Every unnamed transition refused, exhaustively | › the exhaustive 8 × 9 transition matrix | ✅ |
| Refusals name the attempted transition | › refusals name what was attempted | ✅ |
| At most one published version; publishing supersedes | `domain/item.spec.ts` › publication | ✅ |
| `suspended → published` permitted; `retired` terminal | `domain/item-lifecycle.spec.ts` › what each state permits | ✅ |
| Retirement requires a categorized reason | `domain/item.spec.ts` › transitions | ✅ |
| `itemType` fixed at creation | › creation | ✅ |
| Draft deletable; anything past draft not | › deletion | ✅ |
| ADR-0010 records the divergence from ROADMAP M4 | [ADR-0010](../adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) exists and is cited by `domain/item-lifecycle.ts` | ✅ |

### M3-11 · Publication preconditions
| Criterion | Test | |
|---|---|---|
| `checkPublishable` returns every unmet precondition at once | `domain/publication-preconditions.spec.ts` › every unmet precondition is reported at once | ✅ |
| Refused without tags, provenance, licensing, a valid spec | › INV-07 — tags, provenance, licensing, answer specification | ✅ |
| Refused without a reviewer signature | › INV-07 and INV-12 — the reviewer signature | ✅ |
| Refused without a published solution | › D5 / INV-08 — a solution | ✅ |
| INV-12 — the reviewer is not the author | › INV-07 and INV-12 — the reviewer signature | ✅ |
| INV-01 — AI provenance requires a human signature | › INV-01 — no code path from a model to a published item | ✅ |
| INV-14 — a passing render verdict on every surface is required | › INV-14 / FR-QM-14 — renders on every supported surface | ⚠️ **W1** |
| Facts supplied as evidence, not booleans; domain stays I/O-free | › the check is pure | ✅ |
| Every failure names a stable code | › the aggregate refuses to publish on an unsatisfied verdict | ✅ |
| A fully-satisfied item publishes | › a complete item publishes | ✅ |

### M3-12 · `Stimulus` & `StimulusVersion`
| Criterion | Test | |
|---|---|---|
| Field set and four stimulus types | `domain/stimulus.spec.ts` › creation; › a stimulus version | ✅ |
| Same lifecycle machine as `Item` | › transitions | ✅ |
| Retirement refused while a published item references it | › retirement while referenced (FR-TCH-03 rule 3) | ✅ |
| A new version leaves existing associations on the prior one | › editing a published stimulus creates a new version (FR-TCH-03 rule 2) | ✅ |
| Immutability; draft replacement in place | › immutability; › replacing a draft version in place | ✅ |

### M3-13 · `Solution` & `SolutionVersion`
| Criterion | Test | |
|---|---|---|
| Field set, steps, analyses, approaches | `domain/solution.spec.ts` › a solution version | ✅ |
| Step ordinals contiguous from 1, ≥ 1 step | › a solution version | ✅ |
| Distractor analysis names an existing option | › distractor analysis and alternate approaches | ✅ |
| A solution targets an item *version* | › a solution targets an item version (FR-TCH-04 rule 3) | ✅ |
| "Complete" grade computed, never asserted | › the completeness grade is computed, never asserted | ✅ |
| Correcting an explanation stays cheap | › correcting an explanation is the case D5 exists to make cheap | ✅ |

### M3-14 · Final-answer / key agreement
| Criterion | Test | |
|---|---|---|
| Compared against the key projected through M3-08 | `application/final-answer-agreement.spec.ts` › an unusable key | ✅ |
| MCQ: asserted option is the correct one, or the exact set | › option items | ✅ |
| Numeric: compared through the item's own `NumericAnswerSpec` | › numeric items — the executor decides | ✅ |
| Disagreement is blocking | `application/stimulus-solution-handlers.integration.spec.ts` › UpdateSolutionDraft | ✅ |
| Re-checked at publication, not only at authoring | `application/lifecycle-handlers.integration.spec.ts` › publication is refused for each unmet precondition | ✅ |
| Shape mismatches and purity | › shape mismatches; › the check is re-runnable and pure | ✅ |

### M3-15 · `MediaAsset`
| Criterion | Test | |
|---|---|---|
| Asset and version field sets | `domain/media-asset.spec.ts` › version construction; › asset creation and reconstitution | ✅ |
| `altText` required and non-blank **at construction** | › alt text is required at construction, not at publication (ACC-03) | ✅ |
| A complex asset type additionally requires a long description | › an information-bearing asset needs a long description | ✅ |
| `mimeType` from a closed allowlist | › format and dimensions | ✅ |
| No byte-bearing field, asserted over the module's source | › bytes never enter the domain (DEC-6) | ✅ |
| Retirement refused while referenced | › transitions and retirement | ✅ |

### M3-16 · `LocaleVariant`
| Criterion | Test | |
|---|---|---|
| Field set | `domain/locale-variant.spec.ts` › construction | ✅ |
| A variant carries no key, spec or correct-option marker, structurally | › a variant carries no correctness (FR-QM-11 rule 1, D-005) | ✅ |
| A source correctness change invalidates every variant | › a correctness change invalidates every variant | ✅ |
| Attestation is fidelity, not adjudication | › attestation is fidelity, not adjudication (D-005) | ✅ |
| No command, handler, route or surface accepts one | › modeled, not half-shipped | ✅ |

### M3-17 · Pre-submission validation
| Criterion | Test | |
|---|---|---|
| Six blocking findings | `domain/pre-submission-validation.spec.ts` › blocking findings (FR-TCH-07 rule 1) | ✅ |
| Four warnings, none blocking | › warnings never block (FR-TCH-07 rule 2) | ✅ |
| Submission refused while a blocking finding stands | › blocking findings | ✅ |
| Every finding carries a code, a message and a location | › every finding names where the problem is | ✅ |
| Continuous and pure; the draft is not mutated | › the check is pure and continuous | ✅ |
| Blocking and warning sets disjoint and exhaustive | › the code sets are disjoint and exhaustive | ✅ |
| Duplicate detection reports `not_evaluated`, never "none found" | › duplicate detection is M4's, and the report says so | ✅ |

### M3-18 · Content domain events
| Criterion | Test | |
|---|---|---|
| Six events, past tense | `domain/events/content-events.spec.ts` › the event vocabulary | ✅ |
| Payloads carry identifiers only — no key, body or PII | › payloads carry identifiers, never content (§9 rules 10 and 12) | ✅ |
| F18 reconciliation against EVENT-TAXONOMY | › F18 — every event has an analytics counterpart or a written exemption | ✅ |
| `ItemPublished` carries the version id and item type, and nothing more | › payloads carry identifiers, never content | ✅ |
| A registration is never another event's | › registrationFor | ✅ |

---

## Track B — Data

### M3-19 · Content schema migration
| Criterion | Test | |
|---|---|---|
| The named tables, singular, snake_case | `infrastructure/content-schema.integration.spec.ts` › the content schema | ✅ |
| No cross-schema foreign key | › §9 rule 3 — no foreign key crosses a schema boundary | ✅ |
| Every JSONB column has a `*_schema_version` sibling | › F5 — every JSONB column has a sibling *_schema_version | ✅ |
| Derived projections stored alongside the document | `infrastructure/item.repository.integration.spec.ts` › the derived projections are recomputed, never accepted | ✅ |
| `content_media_ref` as a real relationship | › the media usage graph | ✅ |
| `alt_text` NOT NULL with a non-blank check | › ACC-03 — alt text is enforced at the database | ✅ |
| `tenant_id`, `aggregate_version`, `created_at`; `deleted_at` on `item` only | › the content schema | ✅ |
| At most one published version per item | › INV-03 — at most one published version, and it must exist | ✅ |
| Migration runs up, down and up again | › migrations run up, down and up again | ✅ |
| INV-01 enforced at the database in both directions | › INV-01 at the database — AI provenance is traceable | ✅ |

### M3-20 · Published-version immutability & grants
| Criterion | Test | |
|---|---|---|
| Nine tables reject UPDATE and DELETE once published | `infrastructure/content-immutability.integration.spec.ts` › a published version is immutable (INV-03) | ✅ |
| A draft version remains editable | › a draft version is editable — that is what the draft state is for | ✅ |
| A version's parts freeze with it | › a published version's parts freeze with it; › the media usage graph freezes with its owner | ✅ |
| The permitted-update set explicit and minimal | › the trigger surface itself | ✅ |
| No write grant for the app role on published-version tables | `fitness/content-rules.integration.spec.ts` › F7/F40 — no TRUNCATE grant | ⚠️ **W2** |
| Proven from raw SQL, not only through the ORM | › a published version is immutable (INV-03) | ✅ |
| Migrations reversible with the triggers in place | › migrations run up, down and up again with the triggers in place | ✅ |

> **Correction, 2026-08-19.** Both "migrations run up, down and up again" rows above (M3-19 and this one)
> were true as verified — `infra/migrations/20260814100000_app_role.sql` landed two days after this document
> was written and is not part of what these tests exercised then. Its down path called `DROP ROLE IF EXISTS
> questionbank_app` after `DROP OWNED BY`, which only revokes the role's privileges in the *current*
> database; once the role held grants in a second database too (`questionbank`, per the README's own setup
> steps), the cluster-wide `DROP ROLE` failed and every `revertMigrations()` after it did too — silently,
> until M4 found it. Fixed in that migration file; proven by
> `apps/api/src/testing/app-role-cluster-scope.integration.spec.ts`.

### M3-21 · `Item` repository
| Criterion | Test | |
|---|---|---|
| Save transactional across nine tables | `infrastructure/item.repository.integration.spec.ts` › one aggregate, one transaction (§10) | ✅ |
| Load reconstitutes an identical aggregate | › save and load round trip | ✅ |
| The stored document round-trips; projections equal a recomputation | › the derived projections are recomputed, never accepted | ✅ |
| The four finders | › drafts are scoped to their author; › versions accumulate and publication pins one; › the stimulus reference count | ✅ |
| Optimistic concurrency on `aggregate_version` | › optimistic concurrency (P8) | ✅ |
| Decimal literals survive as text | › the numeric key crosses as text (ADR-0007) | ✅ |
| Casing boundary here and nowhere else | › the casing boundary lives here and nowhere else (§2) | ✅ |

### M3-22 · `Stimulus` repository
| Criterion | Test | |
|---|---|---|
| Round trip including body and licensing | `infrastructure/stimulus.repository.integration.spec.ts` › save and load round trip | ✅ |
| `countReferencingPublishedItems` as a join | › the reference count FR-TCH-03 rule 3 consumes | ✅ |
| A new version leaves prior associations pinned | › editing a published stimulus creates a version items do not follow | ✅ |
| Concurrency and failure reporting | › optimistic concurrency (P8); › failures are reported | ✅ |

### M3-23 · `Solution` repository
| Criterion | Test | |
|---|---|---|
| Save transactional across five tables | `infrastructure/solution.repository.integration.spec.ts` › save and load round trip | ✅ |
| Step ordinals preserved and returned in order | › save and load round trip | ✅ |
| `findPublishedForItemVersion` keyed on the version | › a solution targets a version, and the lookup is keyed on one (D5) | ✅ |
| The final answer survives storage as authored | › the final answer survives storage | ✅ |
| Media in an explanation joins the usage graph | › media referenced by an explanation joins the usage graph | ✅ |

### M3-24 · `MediaAsset` repository & `content_media_ref`
| Criterion | Test | |
|---|---|---|
| Round trip; `altText` non-null at the database | `infrastructure/media-asset.repository.integration.spec.ts` › save and load round trip | ✅ |
| Edges written in the owning version's transaction | `infrastructure/item.repository.integration.spec.ts` › the media usage graph is written from the document | ✅ |
| `countReferencingPublishedContent` spans all three owner types | › the usage graph FR-QM-06 rule 3 consumes | ✅ |
| Edge set reconciled on re-save | › the media usage graph is written from the document | ✅ |
| An asset referenced by published content refuses retirement | › the usage graph FR-QM-06 rule 3 consumes | ✅ |
| No byte crosses the boundary | › bytes never cross this boundary (DEC-6) | ✅ |

---

## Track C — Application

### M3-25 · Item authoring commands, handlers & autosave
| Criterion | Test | |
|---|---|---|
| Four commands | `application/authoring-handlers.integration.spec.ts` › CreateItemDraft; › UpdateItemDraft; › DeriveDraftFromVersion; › DeleteItemDraft | ✅ |
| Autosave is an idempotent update; a repeat adds no version | › UpdateItemDraft — autosave | ✅ |
| Drafts visible only to their author and Content Ops | › drafts are scoped to their author (FR-TCH-06 rule 1) | ✅ |
| Draft deletion permanent and audited; past draft refused | › DeleteItemDraft | ✅ |
| Timestamps injected from a clock port | › CreateItemDraft | ✅ |
| Audit written per mutation | `application/authoring-boundary.spec.ts` › the audit recorder | ✅ |
| A policy-less handler fails boot | › the registry is the F36 gate | ✅ |
| A rejected write is reported, never reported as success | › the handlers fail closed on a rejected write | ✅ |

### M3-26 · Stimulus & solution commands and handlers
| Criterion | Test | |
|---|---|---|
| Stimulus commands; attachment pins the current version | `application/stimulus-solution-handlers.integration.spec.ts` › AttachStimulusToItem pins a version (FR-TCH-03 rule 2) | ✅ |
| Solution commands targeting a specific item version | › CreateSolutionDraft; › UpdateSolutionDraft | ✅ |
| Final-answer agreement checked on every solution save | › UpdateSolutionDraft | ✅ |
| Each handler declares a policy; subject scope enforced | › subject-scoped authoring (FR-TCH-01 rule 1) | ⚠️ **W3** |
| A later stimulus edit does not move the attachment | › a published item still reads what it was attached to | ✅ |
| Failures fail closed | `application/stimulus-solution-boundary.spec.ts` | ✅ |

### M3-27 · Media commands & the `MediaStore` port
| Criterion | Test | |
|---|---|---|
| Three commands | `application/media-handlers.integration.spec.ts` › RegisterMediaAsset; › AddMediaAssetVersion; › RetireMediaAsset | ✅ |
| `MediaStore` is a port with an in-memory double | › RegisterMediaAsset | ✅ |
| Checksum recorded at registration, re-verified before publication | › the checksum is what makes a swapped object detectable | ✅ |
| Retirement refused while referenced | › RetireMediaAsset | ✅ |
| No handler, DTO, route or event carries bytes | › bytes never cross the context boundary (DEC-6) | ✅ |
| Authorization negative paths | › authorization; `application/media-boundary.spec.ts` | ✅ |

### M3-28 · Lifecycle commands & permission gates
| Criterion | Test | |
|---|---|---|
| Every transition command, item, stimulus, solution and media | `application/lifecycle-handlers.integration.spec.ts` › the whole path from draft to published; › the stimulus lifecycle; › the solution lifecycle; › the media asset lifecycle | ✅ |
| `PublishItemVersion` resolves every supplied fact and decides nothing | › publication is refused for each unmet precondition | ✅ |
| Submission locks the draft; withdrawal permitted before review | › withdrawal (FR-TCH-08 rule 2) | ⚠️ **W4** |
| Every transition declares a distinct policy, negative paths tested | › every transition is permission-gated | ✅ |
| Audit per transition naming principal, action, target, justification | › the whole path from draft to published | ✅ |
| Suspension and retirement | › suspension and retirement | ✅ |
| Illegal transitions refused wherever attempted | `application/lifecycle-boundary.spec.ts` › an illegal transition is refused wherever it is attempted | ✅ |

### M3-29 · Content queries — two view families
| Criterion | Test | |
|---|---|---|
| Five authoring queries, carrying the key | `application/queries.integration.spec.ts` › authoring queries carry the key, and only for authoring roles | ✅ |
| Three delivery queries, carrying no key material, asserted per view | › delivery views carry no key material (§9 rule 10, ADR-0009) | ✅ |
| A learner reaching an authoring query is `Authorization`, not empty | › authoring queries carry the key, and only for authoring roles | ✅ |
| `GetPublishedSolution` entitlement-gated; correctness never gated | › entitlement is a distinct kind from authorization (§8) | ✅ |
| Each query declares a policy | `application/queries-boundary.spec.ts` | ✅ |
| A suspended item stops being served | › a suspended item stops being served | ✅ |
| Validation findings reach the author | › the validation findings an author acts on (FR-TCH-07) | ✅ |
| The media library reports what it cannot read | › the media library reports what it cannot read | ✅ |

### M3-30 · Bulk import & rejection report
| Criterion | Test | |
|---|---|---|
| JSON Lines with a mandatory licensing declaration | `application/import-handlers.integration.spec.ts` › the batch header | ✅ |
| Records validated through the same domain constructors | › every authored body is reconstructed through the domain constructor | ✅ |
| Per-record outcome with line, identifier, code and message | › a mixed batch imports the valid and reports the invalid | ✅ |
| Every imported record enters as `draft` | › governance is not bypassed (FR-TCH-11 rule 1) | ✅ |
| `duplicateCheckState: 'deferred'`, wording carries no "none" | › the duplicate check the report does not claim to have run (DEC-7) | ✅ |
| Transactional per record, not per file | › a mixed batch imports the valid and reports the invalid | ✅ |
| A record the database refuses is reported, not lost | › a record the database refuses is reported, not lost silently | ✅ |
| The import is audited and gated | › the import is audited and gated | ✅ |

### M3-31 · Public barrel & boundary enforcement
| Criterion | Test | |
|---|---|---|
| Exports commands, queries and events; no aggregate or repository | `contexts/content/m4-seam.spec.ts` › the barrel exports no aggregate, repository or infrastructure type | ✅ |
| `ContentBody` re-exported with its constructor | › M4 can render what a reviewer looks at (FR-TCH-12 rule 1) | ✅ |
| `AnswerKeyData` re-exported with the server-side-only note | `contexts/content/public/index.ts` header, asserted by › M4 can read the findings and preconditions it displays | ✅ |
| Content imports curriculum and scoring only through barrels | `fitness/boundary-rules.spec.ts` › the content barrel (M3-31) | ✅ |
| `domain/` imports nothing | › F2 — domain imports nothing | ✅ |
| Planted violations caught, all four import forms | › F1 — cross-module imports go through public/ barrels; › import extraction | ✅ |
| An M4 seam spec written against the barrel only | `contexts/content/m4-seam.spec.ts` › M4 can construct the commands it drives | ✅ |

### M3-32 · Domain events & outbox emission
| Criterion | Test | |
|---|---|---|
| Every event emitted in the aggregate's transaction | `infrastructure/outbox-emitter.integration.spec.ts` › an event is written inside the aggregate's transaction | ✅ |
| A rolled-back publication leaves no event | › an event is written inside the aggregate's transaction | ✅ |
| Payload inspection on the stored row, per event type | › what a payload may not carry (§9 rules 10, 12) | ✅ |
| F18 reconciliation | › F18 — every event reconciles against the taxonomy | ✅ |
| A publication emits its event in the same transaction | `application/lifecycle-handlers.integration.spec.ts` › a publication emits its event in the same transaction | ✅ |

---

## Track D — API

### M3-33 · OpenAPI contract & ADR-0009
| Criterion | Test | |
|---|---|---|
| Every endpoint names a handler that exists | `contracts/content-contract.spec.ts` › F15 — every endpoint reconciles with a real handler | ✅ |
| RFC 9457 with a stable code and explicit `retryable` | › §8 — every error is RFC 9457 with an explicit retryable flag | ✅ |
| Two schema families, asserted against the document | › ADR-0009 condition 2 — the check asserts both directions | ✅ |
| The authoring route list enumerated and closed, both ways | › ADR-0009 condition 1 — the authoring route list is enumerated and closed | ✅ |
| No `Authoring*` schema reachable from a delivery route | › ADR-0009 condition 3 | ✅ |
| Zod generated from the document, compared byte for byte | › D18 — the Zod schemas are generated, not hand-written | ✅ |
| The document validates against the 3.1 meta-schema | › structural validity (D7 remains open — this is not the meta-schema) | ⚠️ **W5** |
| Decimal literals never become doubles | › the decimal literal never becomes a double | ✅ |
| ADR-0009 written, carrying the three ratified conditions | [ADR-0009](../adr/ADR-0009-authoring-dtos-carry-the-answer-key.md), pinned by › ADR-0009 condition 3 | ✅ |

### M3-34 · Content controllers
| Criterion | Test | |
|---|---|---|
| Authoring routes under `/v1/authoring/` reach their handlers | `contexts/content/api/content.controller.integration.spec.ts` › every authoring route reaches its handler | ✅ |
| Three delivery routes | › every delivery route reaches its handler | ✅ |
| Paths plural and kebab-case; JSON camelCase | `contracts/content-contract.spec.ts` › API conventions (§2) | ✅ |
| Input validated at the boundary, failures are Problem Details | › §8 — the boundary refuses what it cannot type | ✅ |
| Module boot fails without a policy, proven with a planted handler | › F36 — a policy-less handler fails boot | ✅ |
| Correlation ID on every response | › §8 — the boundary refuses what it cannot type | ✅ |
| Live delivery output scanned for key material | › a delivery response carries no key material, over live output | ✅ |

---

## Track E — Rendering & Studio

### M3-35 · `packages/content-renderer/`
| Criterion | Test | |
|---|---|---|
| One `ContentRenderer` taking a body and a surface | `packages/content-renderer/src/content-renderer.spec.tsx` › every node kind renders, on every surface profile | ✅ |
| The surface is a parameter, not four components | › the surface is a parameter, not four components (INV-14) | ✅ |
| Every node kind renders | › every node kind renders, on every surface profile | ✅ |
| An unknown kind renders a labelled fallback and reports it | › an unknown node degrades visibly and reports itself | ✅ |
| Zero imports from either app | › F19 — the package imports neither application | ✅ |
| Semantic HTML; every figure carries its alt text | › semantic HTML, not a pile of divs | ✅ |
| No hardcoded colour outside the token layer | › F24 / §9 rule 16 — no colour outside the token layer | ✅ |
| F20 by monorepo-wide scan | `fitness/content-rules.spec.ts` › F20 — exactly one ContentRenderer in the monorepo | ✅ |
| The vocabulary agrees on both sides of the seam | `contexts/content/renderer-seam.spec.ts` › the node vocabulary is the same on both sides (DEC-2) | ✅ |

### M3-36 · Mathematical notation → MathML
| Criterion | Test | |
|---|---|---|
| LaTeX becomes real MathML | `packages/content-renderer/src/math-node.spec.tsx` › LaTeX becomes real MathML, not HTML that looks like mathematics | ✅ |
| The authored alternative is the accessible name | › the authored alternative is the accessible name (ACC-02) | ✅ |
| Deterministic across calls and profiles | › rendering is deterministic | ✅ |
| Invalid LaTeX degrades and reports to the validation surface | › invalid LaTeX degrades and reports (FR-QM-14 rule 2) | ✅ |
| Long expressions scroll inside their own container | › layout and accessibility | ✅ |
| Temml is the named library | `latex-to-mathml.ts` header records the substitution | ⚠️ **W6** |

### M3-37 · Chemical notation → MathML
| Criterion | Test | |
|---|---|---|
| Every notation class renders through the same pipeline | `packages/content-renderer/src/chem-node.spec.tsx` › each notation class renders through the MathML pipeline | ✅ |
| The authored alternative is the accessible name | › the authored alternative is the accessible name, as for mathematics | ✅ |
| Deterministic and identical across profiles | › rendering is deterministic and identical across profiles | ✅ |
| A structure degrades to the documented affordance | › a structure degrades to the documented affordance (DEC-6, D19) | ✅ |
| axe clean rendered and degraded alike | › accessibility | ✅ |

### M3-38 · Render validation across four surfaces
| Criterion | Test | |
|---|---|---|
| `validateRender` across all four profiles | `packages/content-renderer/src/render-validation.spec.tsx` › the verdict M3-11 consumes | ✅ |
| A failure on any surface blocks publication | › the verdict M3-11 consumes | ✅ |
| Byte-for-byte parity over a fixture corpus | › preview matches the delivery render, byte for byte | ✅ |
| Preview defaults to the minimum device profile | › preview defaults to the minimum device profile (FR-QM-14 rule 3) | ✅ |
| Failures name the block index and the reason | › the verdict M3-11 consumes | ✅ |
| A planted divergence fails the suite | › preview matches the delivery render, byte for byte | ✅ |
| The corpus covers every node kind, asserted by enumeration | › the fixture corpus covers every node kind | ✅ |

### M3-39 · Studio shell, sidebar & the 1280 px gate
| Criterion | Test | |
|---|---|---|
| Persistent sidebar; M3 surfaces live, the rest declared and disabled | `apps/studio/src/shell/StudioShell.spec.tsx` › the sidebar (FRONTEND §2) | ✅ |
| Below 1280 px an explicit gate and no authoring surface | › the 1280 px gate (FRONTEND §2, §9) | ✅ |
| Command palette with keyboard-first navigation | › the command palette (⌘K) | ✅ |
| Focus moves to the main heading on destination change | › focus moves to the main heading on destination change | ✅ |
| The sidebar is fully keyboard-operable | › the sidebar (FRONTEND §2) | ✅ |
| No entry point, no dev server, no router dependency | › the route table is data, not a router (DEC-5) | ✅ |
| Every destination has an accessible name; axe clean | › accessibility | ✅ |

### M3-40 · Item Editor
| Criterion | Test | |
|---|---|---|
| Dual-mode notation input, switchable mid-item, lossless both ways | `apps/studio/src/features/item-editor/ItemEditor.spec.tsx` › dual-mode notation input, switchable mid-item | ✅ |
| The palette's reading of an expression loses nothing | `apps/studio/src/authoring/body-draft.spec.ts` › the palette reading of an expression loses nothing | ✅ |
| Live preview through the renderer at mobile width by default | › the live preview is the delivery render (UX §10.1, INV-14) | ✅ |
| Autosave debounced on an idempotent update; no keystroke lost | › autosave (FRONTEND §7, M3-25) | ✅ |
| Validation continuous and inline, blocking only at submit | › validation is continuous and inline, blocking only at submit | ✅ |
| The key is edited here and nowhere else | `apps/studio/src/authoring/key-boundary.spec.ts` | ✅ |
| The surface is reachable only under an authoring policy | › the authoring policy gates the surface (DEC-4) | ✅ |
| Options authored as `ContentBody` | › options are authored as ContentBody, so an option can be an equation | ✅ |
| Labels, `aria-describedby`, error summary with focus moved to it | › accessibility (FRONTEND §7, §10); › validation is continuous and inline | ✅ |
| Distractor authoring prompts for the misconception | › distractor authoring prompts for the misconception | ✅ |
| The editor derives no governance finding | › the editor derives no governance finding | ✅ |

### M3-41 · Stimulus & Solution editors
| Criterion | Test | |
|---|---|---|
| Attach-existing offered before create-new | `apps/studio/src/features/stimulus-editor/StimulusEditor.spec.tsx` › attach-existing is offered before create-new | ✅ |
| The attach flow shows which items already reference it | › the attach flow shows what already references the stimulus | ✅ |
| The solution editor shows the item and its key alongside | `apps/studio/src/features/solution-editor/SolutionEditor.spec.tsx` › the item and its key sit alongside the explanation | ✅ |
| Final-answer disagreement surfaces immediately | › final-answer disagreement surfaces immediately (M3-14) | ✅ |
| Step ordering drag-free and keyboard-operable | › step reordering is drag-free and keyboard-operable | ✅ |
| Distractor analysis prompted per incorrect option, with its body shown | › distractor analysis is prompted per incorrect option, with the option shown | ✅ |
| axe clean on both | › accessibility (each file) | ✅ |

### M3-42 · Media library & alt-text enforcement
| Criterion | Test | |
|---|---|---|
| Alt text cannot be skipped — the action is unavailable without it | `apps/studio/src/features/media-library/MediaLibrary.spec.tsx` › alt text cannot be skipped (FR-QM-06, ACC-03) | ✅ |
| A complex asset type additionally requires a long description | › a complex asset needs a long description as well | ✅ |
| The usage graph is visible | › the usage graph is visible (M3-24) | ✅ |
| Retirement refused in the UI and in the domain, with the reason stated | › retirement is refused, and the surface says why (FR-QM-06 rule 3) | ✅ |
| axe clean | › accessibility | ✅ |

### M3-43 · Item browser & the validation panel
| Criterion | Test | |
|---|---|---|
| Filter by state, subject, concept and author; filters live in the URL | `apps/studio/src/features/item-browser/ItemBrowser.spec.tsx` › the filters reach the URL | ✅ |
| Filters typed and validated, not parsed ad hoc | › filters are typed, validated search state (FRONTEND §5, §8) | ✅ |
| Drafts show only the author's own | › drafts are scoped to their author (FR-TCH-06 rule 1) | ✅ |
| The empty state is designed, not defaulted | › the empty state is designed, not defaulted (UX §12) | ✅ |
| Blocking and warning grouped, each with its location | › the validation panel (FR-TCH-07, DEC-7) | ✅ |
| Duplicate detection stated as not run | › the validation panel (FR-TCH-07, DEC-7) | ✅ |
| A published row shows its version and links to the history | › a published row shows its version and links to the history | ✅ |
| axe clean | › accessibility | ✅ |

---

## Track F — Gates

### M3-44 · Fitness functions & coverage thresholds
| Criterion | Test | |
|---|---|---|
| F6/F35 amended per ADR-0009, asserted in both directions | `fitness/content-rules.spec.ts` › F6/F35 — the key is on the authoring surface and nowhere else | ✅ |
| The authoring route list an enumerated closed constant | `contracts/content-contract.spec.ts` › ADR-0009 condition 1 | ✅ |
| No `Authoring*` DTO reachable from a delivery controller, by import graph | `fitness/content-rules.spec.ts` › ADR-0009 condition 3 | ✅ |
| F20 by monorepo-wide scan | › F20 — exactly one ContentRenderer in the monorepo | ✅ |
| INV-01 structural — no AI import path into content | › INV-01 — no import path from an AI context into content | ⚠️ **W7** |
| INV-01 — no publication path accepts a machine signature on AI content | › INV-01 — no publication path accepts a machine signature on AI content | ✅ |
| INV-14 — no rendered-markup field in the vocabulary, by scan | › INV-14 — the vocabulary carries no rendered markup or image of text | ✅ |
| F5 by catalogue query | `fitness/content-rules.integration.spec.ts` › F5 | ✅ |
| F7/F40 — no write grant on published-version tables | › F7/F40 | ⚠️ **W2** |
| The M1/M2 fitness set still green | › the M1/M2 fitness set is still run, not assumed; the named specs run in the same suite | ✅ |
| Coverage thresholds for every correctness-bearing content module | › ADR-0008 — every correctness-bearing content module carries a 100% threshold | ✅ |
| The gate verified failing before it passes | › ADR-0008 (three planted failures); Studio verified failing at 99% branches | ✅ |
| The list polices itself — missing, weak, or deleted | › ADR-0008 | ✅ |
| Every check red on its planted fixture | Each describe carries a "fires on…" test against `src/fitness-fixtures/` | ✅ |

### M3-45 · Import corpus — 500 records
| Criterion | Test | |
|---|---|---|
| 500 records generated deterministically from a seeded builder | `testing/import/import-corpus.integration.spec.ts` › the corpus is generated, not hand-written | ✅ |
| The corpus includes every rejection class | › the corpus is generated, not hand-written | ⚠️ **W8** |
| The rejection report asserted exactly, by code | › 500 records import with an exactly-matching rejection report | ✅ |
| Valid records all land in `draft` and are retrievable | › 500 records import with an exactly-matching rejection report | ✅ |
| The import completes within the per-commit budget | The spec runs in the integration project; wall time under 2 s | ✅ |
| A planted acceptance fails the suite | › the exactness check can fail | ✅ |
| No SQL reaches the report | › 500 records import with an exactly-matching rejection report | ✅ |

---

## Findings

| # | Criterion | What is actually proven, and what is not | Debt |
|---|---|---|---|
| **W1** | M3-11 — publication requires a passing render check on every surface | The precondition is enforced, and refuses without a verdict. But `RenderValidator` has **no production adapter**: calling `validateRender` from the API needs a composition root, and there is none. The verdict is today supplied only by a test. | **D27** |
| **W2** | M3-20 / M3-44 — no write grant for the app role on published-version tables | The check runs against the real catalogue and the app role holds no TRUNCATE — but **the deployment role does not exist on a local instance** (ADR-0004, no Compose). The spec asserts its absence rather than passing as if it had examined it, and the rule is exercised against planted grant rows. | **D9** (M0 stack) |
| **W3** | M3-26 — subject-scoped authoring is enforced | A Chemistry author reaching for Physics is refused. But **the subject is declared on the command and is not cross-checked against the content**: nothing records the subject of a passage, and `curriculum/public/` exposes no concept→subject-domain lookup. An in-subject author mistagging their own work is not caught. | **D23** |
| **W4** | M3-28 — withdrawal permitted before review begins, refused after | Withdrawal is proven permitted. The "refused after" half cannot be exercised: **until M4 lands, nothing claims a version**, so `in_review` never has a claimant. The port exists and the spec says so. | M4 |
| **W5** | M3-33 — the document validates against the OpenAPI 3.1 meta-schema | The official meta-schema is not in the dependency tree and cannot be fetched. What ships is a **strictly weaker structural check**, named as not-the-meta-schema in its own describe block so a green suite is not read as conformance. | **D7** |
| **W6** | M3-36 — Temml is the MathML emitter (TECH-STACK §1) | Temml is not in the dependency tree and there is no network. An **in-repo converter** stands in behind `latex-to-mathml.ts`; swapping Temml in is a change to that one module. Every other criterion of M3-36 is proven against the substitute. | **D26** |
| **W7** | M3-44 — INV-01 structural: no AI import path into content | The scan runs over the whole content context and is clean. But `contexts/ai/` and `contexts/generation/` **do not exist yet** — this is a tripwire for M5, not a check with something to find. The mechanism is proven against a context that does exist. | M5 |
| **W8** | M3-45 — the corpus includes every rejection class | Nine of twelve classes reject. **Three of the nine the task names are not import rejections by design** and are carried as accepted records with the reasoning stated: `unresolved` licensing is the default a draft starts from (M3-06) and FR-QM-05 rule 4 blocks publication; a solution is a publication precondition, and requiring one would make a previous-year corpus unimportable; "unrenderable" is `validateRender`'s verdict at publication, and a second weaker notion here would be the parallel validator DEC-7 forbids. | — |
| **W9** | Milestone DoD — "an author produces a stimulus-linked set in ≤ 20 min" | **Reported as failed-blocked**, per DEC-5. There is no running application to measure a real author against. The jsdom step count stands as the nearest available evidence. | **D3 / M0** |

---

## What has no criterion here

Two things M3 delivered are not in the task breakdown's acceptance lists, and are
recorded so the next reader does not look for them:

- **`content.review_decision` and its repository** (added at M3-28). The
  publication precondition needed evidence to consume and nothing stored any;
  M4 owns the review *workspace*, not the record. Proven by
  `infrastructure/review-decision.repository.integration.spec.ts` and
  `domain/review-decision.spec.ts`.
- **The three media transitions** (added at M3-32). `MediaAssetPublished` had no
  producer, so `countReferencingPublishedContent` would have been zero forever.
  Proven by `application/lifecycle-handlers.integration.spec.ts` › the media
  asset lifecycle.
