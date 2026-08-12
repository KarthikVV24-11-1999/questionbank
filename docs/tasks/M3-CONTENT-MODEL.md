# M3 — Content Model & Authoring · Task Breakdown
**Milestone:** [ROADMAP.md](../ROADMAP.md) M3 · **Duration:** 6 weeks · **Depends on:** M1, M2
**Deployable:** Studio authoring with drafts persisted, validated and rendered
**Status:** Approved 2026-08-09. All seven opening decisions ratified; three carry amendments — see below.

> 45 tasks, each independently testable. Paths follow [ENGINEERING-HANDBOOK.md](../ENGINEERING-HANDBOOK.md) §1–2.

**Scope boundary.** M3 owns `contexts/content/` and `packages/content-renderer/`. It *models and authors*
content; it does not run the review pipeline, and it never scores. Scoring is consumed exclusively through
`contexts/scoring/public/`, Curriculum exclusively through `contexts/curriculum/public/`.

**What M3 deliberately does not own:**

| Not in M3 | Owner | Why M3 can proceed without it |
|---|---|---|
| `ReviewAssignment`, the review workspace, ageing escalation, `ReviewDecision` capture UI | M4 | M3 needs the publication *precondition* — that a reviewer signature exists and is not the author. It does not need the queue that produces one. See DEC-1 |
| Duplicate detection (FR-QM-04) | M4 | Advisory, never blocking. Import records `duplicateCheckState: 'deferred'` so M4 wires it without a schema change |
| `ItemDefect`, `AnswerKeyChallenge` | M4 | Both are governance intake, and both reference `ItemVersionId` — a value M3 produces |
| `GenerationCandidate` and the AI ACL | M5 | INV-01 is a *boundary* property. M3 proves the boundary exists (no import path, no publication without a human signature); M5 builds what sits on the far side |
| `Form`, `FormItemSlot`, attempt delivery | M6 | M3 publishes item versions. Pinning them into a paper is M6's |
| Empirical difficulty superseding the authored estimate (FR-QM-09) | M11 | `difficultyEstimate` is authored data with a documented successor. Nothing about the model changes when statistics arrive |
| Locale variant *authoring* (FR-QM-11) | H1 | Modeled at M3-16 per DOMAIN-MODEL §5, delivered later (EXT-04) |
| Object-storage upload, CDN, derivative generation | M0 / platform | M3 defines the `MediaStore` port and stores `storageKey` + `checksum`. Bytes never enter the database. See DEC-6 |

---

## Decisions — ratified 2026-08-09

Seven questions the approved document set does not answer. All seven ratified as proposed; **DEC-1, DEC-4 and
DEC-6 carry amendments**, recorded inline below.

**Standing instruction attached to every M3 task.** The answer key is the asset M3 introduces that can
actually harm someone if it leaks. Where a choice is between convenience and keeping keys off delivery
payloads, take the second — without asking.

### DEC-1 · The M3 / M4 governance seam — lifecycle in M3, workspace in M4

[ROADMAP](../ROADMAP.md) M4 lists "Lifecycle state machine (FR-QM-01) with all transitions permission-gated"
as an M4 deliverable. M3's own acceptance says "publication blocked without tags, provenance, resolved
licensing, or a solution". Those cannot both be true as written: a publication *transition* is the thing
being blocked, so M3 needs the state machine that has one.

**Recommended:** **M3 owns the lifecycle state machine and every publication precondition, in the domain.**
M4 owns the workspace that drives it — assignment routing, queue mechanics, ageing, the decision-capture
surface, the rejection taxonomy UI, and duplicate detection.

The split is a risk boundary, not a convenience. A publication precondition is what makes INV-07 and INV-12
structural; leaving it to M4 means three weeks in which "published" means whatever the caller says it means,
and the Studio surface M3 ships would be enforcing it in the UI — which the quality bar forbids outright.

**Amendment (ratified).** ROADMAP M4 says otherwise in print, so the divergence is recorded in
**ADR-0010**, written at M3-10. A task breakdown that quietly contradicts an approved roadmap is how the
next reader learns the roadmap is unreliable.

Concretely, M3 delivers: the seven states and every legal transition; refusal of every illegal one;
publication refused without tags, provenance, resolved licensing, a reviewer signature, a solution, and a
valid answer specification; the self-review prohibition checked at the transition (INV-12); permission gates
declared as authorization policies on every transition handler (F36). M3 does **not** deliver: who gets
assigned what, escalation, batching, or the reviewer's screen.

### DEC-2 · `ContentBody` is a closed, versioned node vocabulary

[DOMAIN-MODEL](../DOMAIN-MODEL.md) §5 defines `ContentBody` as "structured, renderer-agnostic markup carrying
text, mathematical notation, chemical notation, and media references — never rendered markup, never an image
of text", and stops there. [DATA-ARCHITECTURE](../DATA-ARCHITECTURE.md) §2 requires it be a JSONB document
validated against a registered JSON Schema on write, with a `*_schema_version` sibling and three derived
projections (`plain_text`, `notation_terms[]`, `referenced_media_ids[]`). Nobody has specified the nodes.

**Recommended shape:**

```
ContentBody   { schemaVersion: 1, blocks: Block[] }

Block   = Paragraph { inlines[] }
        | MathBlock { latex, textAlternative }
        | ChemBlock { notation, textAlternative }
        | MediaBlock{ assetVersionId, caption?, sizeHint }
        | List      { ordered: bool, items: Block[][] }
        | Table     { header: Inline[][], rows: Inline[][][] }

Inline  = Text      { value, marks: (bold|italic|sub|sup)[] }
        | MathInline{ latex, textAlternative }
        | ChemInline{ notation, textAlternative }
        | MediaRef  { assetVersionId, altTextOverride? }
```

**The vocabulary is closed**, on the same argument the scoring context uses for item types: a renderer that
meets a node kind it does not know cannot render it, and INV-14 promises deterministic rendering across four
surfaces. Adding a node is a reviewed code change plus a `schemaVersion` bump in both the validator and the
renderer, never a data change. `textAlternative` is **mandatory** on every notation node — ACC-02 is not
solved by a rendering library ([FRONTEND-ARCHITECTURE](../FRONTEND-ARCHITECTURE.md) §10), and an equation
with no authored alternative is unreadable to a screen reader no matter how good the MathML is.

### DEC-3 · The answer key lives on `ItemVersion.responseSpec` and is *projected* to Scoring

DOMAIN-MODEL §5 puts a polymorphic `ResponseSpecification` on `ItemVersion`. M2's barrel exposes
`AnswerKeyData` and `createAnswerKey`, and the handoff states the response specification "must reach the
executor unchanged".

**Recommended:** `ItemVersion.responseSpec` is the authored source of truth and carries **both** the
presentation (option identities, option bodies, ordinals) and the key (which option is correct, or the
numeric specification). A pure function `toAnswerKeyData(responseSpec)` projects the key half into the shape
`scoring/public/` names, and **the projection is validated by passing it through `createAnswerKey` and
`checkKeyMatchesItemType` from the barrel** — not by hand-checking it. A specification whose projection the
executor refuses cannot be saved, let alone published.

**The item-type vocabulary is mirrored, not re-declared.** A test asserts that content's `ITEM_TYPES` equals
`Object.keys(KEY_KIND_BY_ITEM_TYPE)` as reached through the barrel, so adding a type in one context fails the
build until it is added in both. All four types are **modeled** (M2 already accepts all four, and DOMAIN-MODEL
§5's H1 note says the two extra specs arrive "without changing `Item`"); the Studio surface exposes
single-correct MCQ and numeric in v1, per FR-TCH-02 rule 2.

### DEC-4 · Two DTO families, and an amendment to the answer-key fitness rule → **ADR-0009**

§9 rule 10 and F6/F35 say answer keys and solutions are absent from *every* client payload, blocking. M2
asserts exactly that over its DTOs and its OpenAPI document. **M3 breaks it, necessarily:** the authoring
surface is where a key is written, so it must reach the author's browser.

**Recommended:** split the payload surface in two, and make the split enforceable rather than a matter of
care.

| Family | Routes | Carries a key? | Policy |
|---|---|---|---|
| `Authoring*Dto` | `/v1/authoring/**` only | Yes — that is the point | Author (own drafts), Reviewer, Content Ops. Never a learner role |
| `Delivery*Dto` | everything else | **Never**, on any code path | As applicable |

The fitness check is amended, not weakened: instead of "no answer-key field in any DTO", it becomes "no
answer-key field in any DTO outside the enumerated authoring family, **and** every authoring route declares
an authoring-scoped policy, **and** the authoring route list is itself asserted against the OpenAPI document."
A new key-bearing DTO on a delivery route fails. A new authoring route without a policy fails boot (F36). A
key-bearing DTO added to the authoring family requires editing the enumerated list, which is a reviewed diff.

This needs **ADR-0009**, written at M3-33, stating the divergence from the literal rule and this reasoning.
Absent the ADR the rule silently becomes advisory, which is worse than either alternative.

**Amendment (ratified) — three conditions on ADR-0009.** A rule amended with an enumerated exception is
defensible; one amended to "keys allowed where needed" is not.

1. **The authoring route list is enumerated and closed.** Adding to it is a reviewed change to a named
   constant, never an inference from a path prefix at runtime.
2. **The fitness check asserts both directions** — keys **present** on the authoring routes that are supposed
   to carry them, and **absent** everywhere else. It fails if a `Delivery*` DTO ever gains a key-bearing
   field, and equally if an authoring route silently stops carrying one.
3. **No `Authoring*` DTO is reachable from a delivery controller**, asserted structurally by import graph —
   not by naming convention, which a rename defeats.

### DEC-5 · Studio ships as a shell and testable surfaces, not as a running application

Debt **D3** ("Studio app shell, router and 1280 px gate") is dated to M3. But there is no running application
anywhere in this repository — no `main.ts` for the API, no Vite entry point, no Compose, no CI. M0 owns
bootstrapping, and it has not happened.

**Recommended:** M3 builds `StudioShell`, the sidebar navigation, the typed route table and the 1280 px gate
as **modules under `apps/studio/src/shell/`, proven in jsdom**, exactly as M1's Studio features are. No
`main.tsx`, no Vite dev server, no TanStack Router dependency until there is an application to route.

D2 (Playwright E2E) and D10 (p95 measured in a browser) stay deferred and are restated in the M3 close-out.
The alternative — standing up a build, a router and a Playwright harness inside M3 — is M0's work borrowed
against a six-week content milestone, and it would be the second time a milestone paid for M0.

**Consequence, stated plainly:** "an author produces a stimulus-linked set in ≤ 20 minutes" cannot be measured
against a real author on a real screen this milestone. M3 reports it as **failed-blocked on D3/M0**, with the
keystroke-and-step count of the authoring path measured in jsdom as the nearest available evidence. It is not
reported as passed.

### DEC-6 · Chemistry — notation renders through the notation pipeline; structures are `MediaAsset`s

ROADMAP M3 names "server-side chemistry SVG". [TECH-STACK](../TECH-STACK.md) §1 gives the rationale:
pre-rendering at publication removes a heavy client library and makes rendering deterministic (INV-14).
Neither says what a chemistry renderer must actually draw, and "chemistry" covers two very different things.

**Recommended:** v1 renders chemical **notation** — formulae, charges, states, arrows, stoichiometry
(`\ce{2H2 + O2 -> 2H2O}` and the like) — through the same authored-text-alternative pipeline as mathematics,
producing MathML. Chemical **structures** — benzene rings, reaction schemes, mechanism arrows — are authored
as `MediaAsset` diagrams with mandatory alt text and long descriptions, which is what
[DOMAIN-MODEL](../DOMAIN-MODEL.md) §5 already calls a `Stimulus` of type `reaction_scheme`.

A structure-diagram renderer is a subsystem, not a task, and JEE/NEET chemistry items overwhelmingly need
formulae and equations.

**Amendment (ratified) — the deferral gets a named trigger, not an open-ended "later".** Recorded in the M3
close-out debt register as **D19**, owner Frontend, trigger: *the first authored item that a chemistry SME
rejects because an uploaded diagram cannot express what a generated structure would* — i.e. the first
`ChemBlock` degradation affordance (M3-37) that reaches a reviewer as a defect rather than as a choice. Until
then, uploaded diagrams are the answer and the affordance says so.

### DEC-7 · Bulk import is JSON Lines with a batch provenance stanza

FR-TCH-11 and FR-QM-10 require per-record validation, a rejection report, and batch provenance. No document
specifies a format, and M3's acceptance is "500 items imported with a correct rejection report".

**Recommended:** a batch is a JSON Lines file preceded by a header record carrying the batch identity, source
description and a **licensing declaration that every record inherits** (FR-QM-10 rule 2 — an undeclared record
is rejected). Each subsequent line is one item, optionally with its stimulus reference and its solution.
Records are validated through the **same domain constructors** the interactive path uses — not a parallel
validator, which would drift and would let import create drafts the editor considers invalid. Valid records
become drafts; invalid ones enter a rejection report carrying line number, record identifier, error code and
message. Import never bypasses governance (FR-TCH-11 rule 1): everything lands in `draft`.

---

## Task Index

| ID | Task | Track | Depends on |
|---|---|---|---|
| M3-01 | Content context skeleton & error taxonomy | A · domain | — |
| M3-02 | `ContentBody` — the closed node vocabulary (DEC-2) | A · domain | 01 |
| M3-03 | `ContentBody` derived projections | A · domain | 02 |
| M3-04 | `TaxonomyTag` | A · domain | 01 |
| M3-05 | `Provenance` | A · domain | 01 |
| M3-06 | `LicensingStatus` | A · domain | 01 |
| M3-07 | `ResponseSpecification` — options and the four variants | A · domain | 01 |
| M3-08 | **Answer-key projection onto `scoring/public/`** (DEC-3) | A · domain | 07 |
| M3-09 | `ItemVersion` — the immutable snapshot | A · domain | 02, 04, 05, 06, 07 |
| M3-10 | `Item` — identity, versions, lifecycle (DEC-1) | A · domain | 09 |
| M3-11 | **Publication preconditions** — INV-07, INV-12, INV-01 | A · domain | 10 |
| M3-12 | `Stimulus` & `StimulusVersion` | A · domain | 02, 06 |
| M3-13 | `Solution` & `SolutionVersion` | A · domain | 02 |
| M3-14 | Final-answer / key agreement (D5) | A · domain | 08, 13 |
| M3-15 | `MediaAsset` — alt text mandatory | A · domain | 06 |
| M3-16 | `LocaleVariant` — modeled, not delivered | A · domain | 09 |
| M3-17 | Pre-submission validation (FR-TCH-07) | A · domain | 11, 14 |
| M3-18 | Content domain events | A · domain | 10, 12, 13, 15 |
| M3-19 | Content schema migration | B · data | — |
| M3-20 | Published-version immutability & grants | B · data | 19 |
| M3-21 | `Item` repository | B · data | 09, 19 |
| M3-22 | `Stimulus` repository | B · data | 12, 19 |
| M3-23 | `Solution` repository | B · data | 13, 19 |
| M3-24 | `MediaAsset` repository & `content_media_ref` | B · data | 15, 19 |
| M3-25 | Item authoring commands, handlers & autosave | C · app | 21 |
| M3-26 | Stimulus & solution commands and handlers | C · app | 22, 23 |
| M3-27 | Media commands & the `MediaStore` port (DEC-6) | C · app | 24 |
| M3-28 | Lifecycle commands & permission gates | C · app | 11, 25, 26 |
| M3-29 | Content queries — two view families (DEC-4) | C · app | 25, 28 |
| M3-30 | Bulk import & rejection report (DEC-7) | C · app | 25, 26 |
| M3-31 | Public barrel & boundary enforcement | C · app | 25–30 |
| M3-32 | Domain events & outbox emission | C · app | 18, 28 |
| M3-33 | OpenAPI contract & **ADR-0009** (DEC-4) | D · api | 31 |
| M3-34 | Content controllers | D · api | 33 |
| M3-35 | `packages/content-renderer/` — the one renderer (F20) | E · render | 02 |
| M3-36 | Mathematical notation → MathML | E · render | 35 |
| M3-37 | Chemical notation → MathML (DEC-6) | E · render | 36 |
| M3-38 | **Render validation across four surfaces** | E · render | 36, 37 |
| M3-39 | Studio shell, sidebar & the 1280 px gate (DEC-5, D3) | E · studio | — |
| M3-40 | **Item Editor** — dual-mode input, live preview, autosave | E · studio | 38, 39 |
| M3-41 | Stimulus & Solution editors | E · studio | 40 |
| M3-42 | Media library & alt-text enforcement | E · studio | 39 |
| M3-43 | Item browser & the validation panel | E · studio | 39 |
| M3-44 | Fitness functions & coverage thresholds | F · gates | 31, 34, 35 |
| M3-45 | Import corpus — 500 records with a rejection report | F · gates | 30 |

---

## Track A — Content Domain

*Pure logic. No I/O, no framework, no ORM, no clock, no randomness. `domain/` imports nothing (F2). Every
task here returns a typed `Result` and never throws (§8). Tasks 08–11, 14 and 17 are correctness-bearing
under [ADR-0008](../adr/ADR-0008-coverage-follows-correctness-bearing-code.md) and carry a 100% threshold the
moment they land.*

### M3-01 · Content context skeleton & error taxonomy
**Objective** The context anatomy and the typed-result surface everything else returns.
**Files** `apps/api/src/contexts/content/domain/result.ts`, `domain/content-error.ts`
**Acceptance**
- Five-directory anatomy created: `api/`, `application/`, `domain/`, `infrastructure/`, `public/`
- `Result<T, E>` mirrors curriculum's and scoring's — content does **not** import either (§9 rule 2), for the reason M2-01 records
- Error kinds drawn from the closed handbook §8 taxonomy; content uses `Validation`, `NotFound`, `Conflict`, `PreconditionFailed`, `RuleViolation`
- Zero `throw` anywhere under `domain/`
**Tests** Unit: `ok`/`err` construction and narrowing · every error kind constructs · a spec asserting `domain/` contains no `throw`, no clock and no outward import, each proven against a planted violation

### M3-02 · `ContentBody` — the closed node vocabulary (DEC-2)
**Objective** INV-14's mechanism. Structured markup, never rendered markup, never an image of text.
**Files** `domain/content-body.ts`
**Acceptance**
- The block and inline vocabulary of DEC-2, exactly; `BLOCK_KINDS` and `INLINE_KINDS` are closed `as const` tuples
- `schemaVersion` is carried on the document and is `1`
- An unknown block or inline kind is rejected at construction with a named code — never dropped, never passed through
- **`textAlternative` is mandatory and non-blank on every `MathBlock`, `MathInline`, `ChemBlock` and `ChemInline`** (ACC-02)
- **No node can carry rendered markup:** a `Text.value` containing an HTML tag, or any field named `html`/`rendered`/`svg`, is rejected. A spec asserts the vocabulary has no such field
- Empty document rejected; a `Paragraph` with no inlines rejected; a `Table` with ragged rows rejected
- Construction is total and immutable — an invalid document returns `Validation`, never a partially-built one
**Tests** Unit: every node kind constructs · unknown kind rejected · notation without a text alternative rejected, per node kind · blank alternative rejected · HTML in a text value rejected · ragged table rejected · deep freeze asserted · 100% branch

### M3-03 · `ContentBody` derived projections
**Objective** DATA-ARCHITECTURE §2 — the three projections written at the same time as the document.
**Files** `domain/content-body-projections.ts`
**Acceptance**
- `plainText(body)` — reading order, notation rendered as its **`textAlternative`**, media as its alt text. This is what FTS indexes and what a screen reader's order must match
- `notationTerms(body)` — the symbolic search field: normalized tokens from every math and chem node
- `referencedMediaIds(body)` — every `assetVersionId`, deduplicated, in document order. This is what `content_media_ref` is built from, so an asset used twice is one edge
- All three are pure and deterministic: the same document yields byte-identical output on repeat calls
- Projections are **derived, never authored** — no setter, and a spec asserts no aggregate accepts them as input
**Tests** Unit: reading order across nested lists and tables · notation contributes its alternative to `plainText`, never its LaTeX · duplicate media reference yields one id · empty projections on a text-only body · determinism over 100 calls · 100% branch

### M3-04 · `TaxonomyTag`
**Objective** DOMAIN-MODEL §5 — tags bind to a taxonomy version, not to a floating concept name.
**Files** `domain/taxonomy-tag.ts`
**Acceptance**
- `{ conceptIdentityId, taxonomyVersionId, weight, isPrimary }`
- **Every tag names a `taxonomyVersionId`** (FR-TCH-05 rule 1) — a tag without one cannot be constructed, which is what makes FR-QM-13 migration possible later
- At least one tag required on a tagged set; **exactly one** `isPrimary`
- Weights in `[0, 1]`; duplicate `conceptIdentityId` within a set rejected
- All tags in one set share one `taxonomyVersionId` — a set spanning two versions is `Validation`
**Tests** Unit: valid set constructs · missing taxonomy version rejected · zero primaries rejected · two primaries rejected · duplicate concept rejected · mixed taxonomy versions rejected · weight bounds on both sides · 100% branch

### M3-05 · `Provenance`
**Objective** FR-QM-05 — every item's origin, immutable once published.
**Files** `domain/provenance.ts`
**Acceptance**
- `sourceType`: `original | previous_year | licensed | ai_generated | ai_assisted` — a closed set
- `previous_year` requires `sourceExam` and `sourceYear`; `licensed` requires an attribution reference
- **`ai_generated` and `ai_assisted` each require `modelVersionId`, `promptVersionId`, `generationRunId` and `confidence`** (FR-QM-05 rule 3). Missing any is `Validation` — this is half of what makes INV-01 checkable
- An unknown `sourceType` is rejected, never coerced to `original`
- Immutable once constructed
**Tests** Unit: each source type's required fields present and absent · AI provenance missing each of its four fields, separately · unknown source type rejected · immutability · 100% branch

### M3-06 · `LicensingStatus`
**Objective** FR-QM-05 rule 4 — `unresolved` blocks publication unconditionally.
**Files** `domain/licensing-status.ts`
**Acceptance**
- `{ status: owned | licensed | public_domain | unresolved, licenseRef?, attribution?, expiresAt? }`
- `licensed` requires `licenseRef` **and** `attribution`
- `isPublishable(status, asOf)` returns false for `unresolved` **and** for a `licensed` status whose `expiresAt` has passed — expiry is supplied, never read from a clock in the domain
- The default for a new draft is `unresolved`, so an author must make a positive statement rather than inherit a permissive one
**Tests** Unit: each status constructs · `licensed` missing either field rejected · `unresolved` never publishable · expired licence not publishable at a supplied instant, publishable before it · boundary exactly at `expiresAt` · default is `unresolved` · 100% branch

### M3-07 · `ResponseSpecification` — options and the four variants
**Objective** DOMAIN-MODEL §5's polymorphic spec, as authored data.
**Files** `domain/response-specification.ts`
**Acceptance**
- `ITEM_TYPES` closed: `SINGLE_CORRECT_MCQ`, `MULTIPLE_CORRECT_MCQ`, `MATCHING`, `NUMERIC` (DEC-3)
- `SingleCorrectSpec { options[], correctOptionId }`, `MultiCorrectSpec { options[], correctOptionIds[] }`, `MatchingSpec { left[], right[], pairs[] }`, `NumericSpec { spec: NumericAnswerSpecData }`
- An `Option` is `{ optionId, ordinal, body: ContentBody }` — **an option body is a `ContentBody`**, so an option can carry an equation, which the category routinely gets wrong by storing option text as a string
- Option ordinals contiguous from 1; duplicate `optionId` rejected; MCQ requires ≥ 2 options
- `correctOptionId` must name an existing option; every `correctOptionIds` member must; a matching pair's members must exist on their side
- **`NumericSpec` requires the parameters its comparison mode needs** (D-001 rule 5, FR-TCH-02 rule 3) — the check is delegated to M3-08's projection, not re-implemented here
- Immutable once constructed
**Tests** Unit: each variant constructs · single-option MCQ rejected · ordinal gap rejected · duplicate option id rejected · correct option naming an absent option rejected, per variant · matching pair naming an absent member rejected · option body is a validated `ContentBody` · 100% branch

### M3-08 · Answer-key projection onto `scoring/public/` (DEC-3)
**Objective** The seam. The response specification must reach the executor unchanged.
**Files** `domain/answer-key-projection.ts`
**Acceptance**
- `toAnswerKeyData(spec): AnswerKeyData` — the shape `scoring/public/` names, and nothing else
- **The projection is validated by the barrel, not by hand**: the result is passed through `createAnswerKey` and `checkKeyMatchesItemType` from `contexts/scoring/public/`, and a specification whose projection either refuses cannot be constructed
- `NumericSpec` projects its **authored decimal literal** as text — never a JavaScript number, at any point on the path (ADR-0007, and the seam's own guarantee)
- Normalization flags are passed through as authored; absent flags are left absent for the executor to default
- A spec asserts content's `ITEM_TYPES` equals the barrel's item-type vocabulary, so a type added in one context fails the build until added in both
- **The projection is one-way.** Nothing reconstructs a `ResponseSpecification` from an `AnswerKeyData`; a spec asserts no such function exists
**Tests** Unit: all four variants project and are accepted by `createAnswerKey` · a numeric spec with a missing mode parameter is refused at projection · `0.1` survives as the literal `"0.1"`, asserted textually · unit spec and accepted forms survive · item-type vocabularies asserted equal · variant/type mismatch refused · **an end-to-end test scores an attempt built from a projected key using only barrel exports** · 100% branch

### M3-09 · `ItemVersion` — the immutable snapshot
**Objective** DOMAIN-MODEL §5's `ItemVersion`, immutable once published (INV-03).
**Files** `domain/item-version.ts`
**Acceptance**
- `{ versionId, versionNo, stem: ContentBody, responseSpec, taxonomyTags[], difficultyEstimate, provenance, licensing, stimulusVersionRef?, localeVariants[], authoredBy: PrincipalRef, createdAt }`
- `authoredBy` is a `PrincipalRef` from the shared kernel — human **or** machine (D10), and it is required
- `createdAt` is **supplied**, never read from a clock inside the domain
- **`stimulusVersionRef` pins a version, not a stimulus** (FR-TCH-03 rule 2) — an association survives the stimulus being re-edited
- `difficultyEstimate` in a documented band, and documented in the type as superseded by empirical statistics later (FR-QM-09)
- No mutator exists. An edit produces a **new** version through `deriveDraft(from)`, which increments `versionNo` and carries nothing that must be re-authored
- Immutable, deeply
**Tests** Unit: construction · every required field individually · `deriveDraft` increments and returns a new instance with the original untouched · no `Date.now`/`new Date()` under `domain/`, asserted by spec · deep immutability of nested tags and options · 100% branch

### M3-10 · `Item` — identity, versions, lifecycle (DEC-1)
**Objective** FR-QM-01's state machine, and D1's identity/version split.
**Files** `domain/item.ts`, `domain/item-lifecycle.ts` · **plus `docs/adr/ADR-0010-content-owns-the-lifecycle-state-machine.md`**
**Acceptance**
- `{ itemId, itemType, lifecycleState, currentPublishedVersionId?, versions[], retirementReason?, replacedByItemId? }`
- States: `draft → in_review → (changes_requested | approved | rejected) → published → (suspended | retired)`
- **Every transition the machine does not name is refused**, with the attempted transition in the message. An exhaustive test walks all 7 × 7 pairs and asserts exactly the legal ones succeed
- **At most one published version at a time** — publishing a second version supersedes the first and is the only way `currentPublishedVersionId` changes
- `suspended` clears student visibility while retaining history; `suspended → published` is permitted (reinstatement), `retired → anything` is not (FR-QM-01 rule 5 — content is never hard-deleted after leaving draft)
- Retirement requires a categorized reason (FR-QM-07 rule 3)
- **`itemType` is fixed at creation.** Changing it would invalidate the response specification and every key derived from it
- A draft may be deleted; anything past draft may not (FR-TCH-06 rule 3 — withdraw instead)
- **ADR-0010** records the divergence from ROADMAP M4's placement of the state machine, and DEC-1's reasoning
**Tests** Unit: exhaustive 7 × 7 transition matrix · publishing a second version supersedes the first and leaves it retrievable · retirement without a reason rejected · `retired` is terminal · draft deletion permitted, `in_review` deletion refused · item type immutable · 100% branch

### M3-11 · Publication preconditions — INV-07, INV-12, INV-01
**Objective** The milestone's load-bearing criterion. Enforced in the domain, never in the UI.
**Files** `domain/publication-preconditions.ts`
**Acceptance**
- `checkPublishable(item, version, facts)` returns `ok` or **every** unmet precondition at once — an author who fixes one thing and is told about the next wastes a session (UX §10.1)
- Refuses publication without: ≥ 1 taxonomy tag with a primary; complete provenance; licensing that `isPublishable`; a valid response specification (via M3-08's projection); a reviewer signature; a published solution
- **INV-12 — self-review:** the reviewer named in the signature must not be the version's `authoredBy`. Checked here as well as at assignment, per FR-QM-03
- **INV-01 — no code path from a model to a published item:** where `provenance.sourceType` is `ai_generated` or `ai_assisted`, the reviewer signature must be a `PrincipalRef` of kind `human`. An AI signature is `RuleViolation`
- **INV-14 — render validation:** publication requires a passing render check on every supported surface (FR-QM-14 rule 2). The verdict arrives as a supplied fact; the domain refuses without it
- Solution availability and the render verdict arrive as **supplied facts** resolved by the handler — Solution is a separate aggregate (D5), and the domain stays clock-free and I/O-free
- Every failure names a stable code, so the Studio validation panel groups without string-matching
**Tests** Unit: each precondition individually unmet · all unmet reported together, not one at a time · self-review refused · AI provenance with an AI signature refused, with a human signature accepted · unresolved licensing refused · expired licence refused · missing render verdict refused · a fully-satisfied item publishes · 100% branch

### M3-12 · `Stimulus` & `StimulusVersion`
**Objective** DOMAIN-MODEL §5 — shared context as a first-class aggregate, not a column on the item.
**Files** `domain/stimulus.ts`
**Acceptance**
- `{ stimulusId, stimulusType (passage | diagram | dataset | reaction_scheme), lifecycleState, currentPublishedVersionId?, versions[] }`
- `StimulusVersion { versionId, versionNo, body: ContentBody, licensing, authoredBy, createdAt }`
- Same lifecycle machine as `Item`, and the same immutability
- **Refuses retirement while a published item references it** (FR-TCH-03 rule 3) — the referencing count arrives as a supplied fact
- Editing a published stimulus creates a new version; **existing item associations continue to name the prior version** until explicitly migrated (FR-TCH-03 rule 2), asserted by pinning
**Tests** Unit: each stimulus type · lifecycle reuse asserted against the same matrix · retirement refused with referencing items, permitted at zero · a new version leaves an existing association pointing at the old one · 100% branch

### M3-13 · `Solution` & `SolutionVersion`
**Objective** D5 — the explanatory content, versioned independently of the item.
**Files** `domain/solution.ts`
**Acceptance**
- `{ solutionId, itemId, targetItemVersionId, lifecycleState, currentPublishedVersionId?, versions[] }`
- `SolutionVersion { versionId, versionNo, finalAnswerAssertion, steps[], distractorAnalyses[], alternateApproaches[], authoredBy, createdAt }`
- `SolutionStep { ordinal, body: ContentBody, conceptRefs[] }`, ordinals contiguous from 1, ≥ 1 step required
- `DistractorAnalysis { optionId, misconception: ContentBody }`; `AlternateApproach { label, steps[], applicabilityNote }`
- **A solution targets an item *version*, not an item** — correcting an explanation must not invalidate a single historical attempt (D5, FR-TCH-04 rule 3)
- A "complete" quality grade requires a distractor analysis for **every** incorrect option (FR-TCH-04 rule 2); a solution without them is publishable but not complete, and the grade is computed, never asserted
**Tests** Unit: construction · zero steps rejected · ordinal gap rejected · a distractor analysis naming an absent option rejected · quality grade complete and incomplete · targeting an item version, asserted · 100% branch

### M3-14 · Final-answer / key agreement (D5)
**Objective** DOMAIN-MODEL §5 — "guarantee the stated final answer matches the item's key".
**Files** `domain/final-answer-agreement.ts`
**Acceptance**
- `checkFinalAnswerMatchesKey(solutionVersion, responseSpec)` compares the solution's `finalAnswerAssertion` against the key **projected through M3-08**, never against the raw specification
- MCQ: the asserted option id must be the correct one (or the exact set, for multi-correct)
- Numeric: the asserted value is compared using the item's own `NumericAnswerSpec` — the same comparison the executor would run, reached through `scoring/public/`, so "matches the key" means what it means at scoring time and not something approximately similar
- Disagreement is a **blocking** validation error (FR-TCH-07 rule 1), because a solution that contradicts the key is the defect class that generates answer-key challenges
- Agreement is re-checked at publication, not only at authoring — the key can change after the solution was written
**Tests** Unit: agreement and disagreement per item type · a numeric assertion inside tolerance agrees, outside disagrees, exactly at the boundary agrees · a multi-correct assertion missing one option disagrees · re-check at publication catches a key changed after authoring · 100% branch

### M3-15 · `MediaAsset` — alt text mandatory
**Objective** FR-QM-06 and ACC-03. Bytes never enter the domain, and never enter the database (DEC-6).
**Files** `domain/media-asset.ts`
**Acceptance**
- `{ assetId, assetType, versions[], licensing, lifecycleState }`; `MediaAssetVersion { versionId, versionNo, storageKey, checksum, mimeType, width, height, altText, longDescription?, authoredBy, createdAt }`
- **`altText` is required and non-blank at construction.** Not validated at publication — at construction, so an asset without it cannot exist
- A complex asset type (`diagram`, `chart`, `reaction_scheme`) additionally requires a `longDescription`
- `mimeType` drawn from a closed allowlist; an unknown type is rejected rather than stored and served
- **No byte field exists on the type**, asserted by a spec over the module's own source
- Refuses retirement while referenced by published content (FR-QM-06 rule 3), the count supplied as a fact
**Tests** Unit: construction · blank alt text rejected, whitespace-only rejected · complex type without a long description rejected · unknown mime type rejected · no byte-bearing field, asserted · retirement refused while referenced · 100% branch

### M3-16 · `LocaleVariant` — modeled, not delivered
**Objective** FR-QM-11 / EXT-04 — modeled from day one, delivered in H1.
**Files** `domain/locale-variant.ts`
**Acceptance**
- `{ locale, stem: ContentBody, options[], translatedBy, reviewState }`
- **The source version is authoritative for correctness** (FR-QM-11 rule 1): a variant carries no key, no numeric spec and no correct-option marker. Asserted structurally, not by convention
- A correctness change to the source invalidates every variant until re-reviewed (rule 3) — modeled as `reviewState: invalidated` produced by a pure function over a source-version change
- Per [DECISIONS](../DECISIONS.md) D-005 the variant review is a fidelity attestation, not a full `ReviewDecision`
- No command, handler, route or Studio surface accepts one this milestone — asserted, so "modeled" does not quietly become "half-shipped"
**Tests** Unit: construction · a variant carrying any key-bearing field fails to type-check and fails a source scan · source correctness change invalidates variants · no barrel export accepts a variant · 100% branch

### M3-17 · Pre-submission validation (FR-TCH-07)
**Objective** Catch defects before they consume reviewer time. Blocking versus warning, decided once.
**Files** `domain/pre-submission-validation.ts`
**Acceptance**
- **Blocking** (rule 1): missing answer key, missing tolerance on a numeric item, missing concept tag, missing licensing status, unrenderable notation, missing solution
- **Warning** (rule 2): probable duplicate *(deferred to M4 — reported as `not_evaluated`, never as "none found")*, out-of-declared-scope concept, unusual difficulty, missing distractor analysis
- **Submission is refused while any blocking error remains**, and the refusal is in the domain
- Every finding carries a stable code, a human-readable message, and **a location** — the block index, the option id, the tag — because "invalid item" is a message an author cannot act on (UX §10.1)
- Validation is continuous and pure: the same draft yields the same findings, and running it does not mutate the draft
- Blocking and warning sets are **disjoint and exhaustive** over the finding codes, asserted
**Tests** Unit: each blocking finding individually · each warning individually · submission refused with a blocking finding, permitted with only warnings · every finding carries a location · duplicate check reports `not_evaluated` · code sets disjoint · determinism over repeated runs · 100% branch

### M3-18 · Content domain events
**Objective** Cross-context effects are events, never calls (§9 rule 4).
**Files** `domain/events/content-events.ts`
**Acceptance**
- `ItemPublished`, `ItemSuspended`, `ItemRetired`, `StimulusPublished`, `SolutionPublished`, `MediaAssetPublished` — past tense (§2)
- Payloads carry identifiers and version numbers only: **no answer key, no solution body, no stem, no PII** (§9 rules 10, 12)
- Every event has an analytics counterpart or a recorded exemption (F18), reconciled against [EVENT-TAXONOMY.md](../EVENT-TAXONOMY.md)
- `ItemPublished` carries `itemVersionId` and `itemType`, which is what Assessment needs to pin and Psychometrics needs to key on — and nothing more
**Tests** Unit: each event constructs · payload inspection for key material, body content and PII, per event · F18 reconciliation against the taxonomy · 100% branch

---

## Track B — Data

### M3-19 · Content schema migration
**Objective** The `content` schema, per DATA-ARCHITECTURE §4.
**Files** `infra/migrations/<timestamp>_content_schema.sql`, `contexts/content/infrastructure/schema.ts`
**Acceptance**
- Tables (snake_case, singular): `item`, `item_version`, `item_option`, `item_numeric_spec`, `item_taxonomy_tag`, `item_provenance`, `content_licensing`, `item_version_locale`, `stimulus`, `stimulus_version`, `solution`, `solution_version`, `solution_step`, `distractor_analysis`, `alternate_approach`, `media_asset`, `media_asset_version`, `content_media_ref`
- **No cross-schema foreign key** to `curriculum` (§9 rule 3) — `concept_identity_id` and `taxonomy_version_id` are carried as values on `item_taxonomy_tag`, exactly as scoring carries the profile version
- **Every JSONB column has a sibling `*_schema_version`** (§9 rule 7 / F5): `item_version.stem_body`, `item_option.body`, `stimulus_version.body`, `solution_step.body`, `distractor_analysis.misconception_body`, `alternate_approach.steps`, `item_version_locale.stem_body`
- Derived projections stored alongside the document, written in the same statement: `stem_plain_text`, `notation_terms[]`
- `content_media_ref { owner_type, owner_version_id, media_asset_version_id }` — the usage graph as a real relationship, so "which published items use this asset?" is a join
- `media_asset_version.alt_text` is **`NOT NULL` with a non-blank check** — ACC-03 at the database, not only in the type
- `tenant_id`, `aggregate_version`, `created_at` per the M1 convention (P7, P8, P1); UUIDv7 defaults (P6)
- Partial unique index: at most one published version per item; `deleted_at` on `item` only, for draft deletion (P2)
- Migration runs up, down, and up again on a clean database
**Tests** Integration (real Postgres): up/down/up · catalogue query proving every JSONB column has a version sibling · catalogue query proving no FK crosses a schema · a second published version rejected by the index · a null and a whitespace alt text both rejected · the usage-graph join returns referencing items

### M3-20 · Published-version immutability & grants
**Objective** INV-03 at the database (P5), to the standard M2-19 set.
**Files** `infra/migrations/<timestamp>_content_immutability.sql`
**Acceptance**
- `item_version`, `item_option`, `item_numeric_spec`, `item_taxonomy_tag`, `item_provenance`, `stimulus_version`, `solution_version`, `solution_step`, `media_asset_version` reject `UPDATE` and `DELETE` **once the owning aggregate has published that version**
- A draft version remains editable — this is the one difference from scoring's blanket append-only rule, and it is the whole point of the draft state. The trigger keys on publication, not on insertion
- **The permitted-update set is explicit and minimal**, compared column-wise the way M2-19 does it, so nothing rides along with an allowed change
- No `UPDATE`/`DELETE` grant for the app role on published-version tables (§9 rule 11 / F7 / F40)
- Proven from raw `psql`, not only through the ORM
**Tests** Integration: raw SQL `UPDATE` on a published version rejected, per table · raw SQL `DELETE` rejected, per table · the same update on a draft version permitted · publishing then updating rejected · grant absence asserted by catalogue query

### M3-21 · `Item` repository
**Objective** Persistence with the casing boundary in exactly one place (§2).
**Files** `infrastructure/item.repository.ts`
**Acceptance**
- Save is transactional across `item`, `item_version`, `item_option`, `item_numeric_spec`, `item_taxonomy_tag`, `item_provenance`, `content_licensing` — one aggregate, one transaction (§10)
- Load reconstitutes an identical aggregate: save → load → deep-equal, including the `ContentBody` document and its projections
- **The stored `stem_body` round-trips byte-identically**, and the stored projections equal a fresh recomputation — a drifted projection is a silently wrong search index
- `findById`, `findDraftsByAuthor`, `findPublishedVersion`, `findByStimulusVersion`
- Optimistic concurrency on `aggregate_version` (P8): a stale write is `Conflict`, never a silent overwrite
- The numeric spec's decimal literals survive as **text**, never as a float
- snake_case ↔ camelCase mapping happens here and nowhere else
**Tests** Integration: save/load deep equality · `ContentBody` byte-identity · projections match recomputation · decimal literal `"0.1"` survives as `"0.1"` · concurrent save rejected · drafts scoped to their author · 100% branch

### M3-22 · `Stimulus` repository
**Objective** Persist the stimulus and its version history, with the reference count the domain needs.
**Files** `infrastructure/stimulus.repository.ts`
**Acceptance**
- Save/load round trip including the `ContentBody` and licensing
- `countReferencingPublishedItems(stimulusVersionId)` — the supplied fact M3-12's retirement precondition consumes, computed as a join and not as a JSON scan
- A new version leaves prior item associations pointing at the prior version, asserted against the database
**Tests** Integration: round trip · reference count with zero, one and many referencing items · count excludes unpublished items · associations pinned across a new version · 100% branch

### M3-23 · `Solution` repository
**Objective** Persist the solution, its steps, analyses and approaches.
**Files** `infrastructure/solution.repository.ts`
**Acceptance**
- Save transactional across `solution`, `solution_version`, `solution_step`, `distractor_analysis`, `alternate_approach`
- Step ordinals preserved and returned in order — never in insertion order, never in whatever order the database returns
- `findPublishedForItemVersion(itemVersionId)` — the supplied fact M3-11's publication precondition consumes
**Tests** Integration: round trip · ordering preserved under out-of-order insert · lookup returns nothing for an item version with no published solution and the solution when there is one · 100% branch

### M3-24 · `MediaAsset` repository & `content_media_ref`
**Objective** The usage graph, maintained as content is saved.
**Files** `infrastructure/media-asset.repository.ts`, `infrastructure/content-media-ref.ts`
**Acceptance**
- Save/load round trip; `altText` non-null enforced by the database as well as the type
- **`content_media_ref` rows are written in the same transaction as the owning content version**, derived from M3-03's `referencedMediaIds` — never by a later scan, which would leave a window in which an in-use asset looks unused and can be retired
- `countReferencingPublishedContent(assetVersionId)` spans items, stimuli and solutions in one query
- Re-saving a version reconciles the edge set: added references appear, removed ones disappear, and an unchanged set writes no churn
**Tests** Integration: round trip · edges written with the owning version, and absent when it rolls back · reference count across all three owner types · edge reconciliation on re-save · an asset referenced by published content refuses retirement · 100% branch

---

## Track C — Application

*Orchestration only, no business logic (§1). Every handler declares an authorization policy or the module
fails to boot (§9 rule 6 / F36). Handlers that resolve which version publishes are correctness-bearing under
ADR-0008 and carry a 100% threshold.*

### M3-25 · Item authoring commands, handlers & autosave
**Objective** FR-TCH-02 and FR-TCH-06 — authoring and drafts that survive.
**Files** `application/commands/authoring-commands.ts`, `application/handlers/authoring-handlers.ts`
**Acceptance**
- `CreateItemDraft`, `UpdateItemDraft`, `DeriveDraftFromVersion`, `DeleteItemDraft`
- **Autosave is `UpdateItemDraft` with an `idempotencyKey`** — a repeat is a no-op returning the current version, so a flaky connection retrying does not produce a version history of keystrokes
- **Drafts are visible only to their author and Content Ops** (FR-TCH-06 rule 1), enforced by policy and tested on the negative path
- Deleting a draft is permanent and audited; deleting anything past `draft` is refused (rule 3)
- `createdAt` and `updatedAt` are injected from a clock port, keeping the domain clock-free
- Every mutation carries a `PrincipalRef` and writes an audit record through the `AuditRecorder` port (INV-02, D4's in-memory implementation)
**Tests** Unit + integration: create, update, derive, delete · autosave repeat produces no second version · cross-author draft read refused · Content Ops read permitted · deleting a submitted item refused · audit written per mutation · policy-less handler fails boot · 100%

### M3-26 · Stimulus & solution commands and handlers
**Objective** FR-TCH-03 and FR-TCH-04.
**Files** `application/commands/stimulus-commands.ts`, `application/commands/solution-commands.ts`, and their handlers
**Acceptance**
- `CreateStimulusDraft`, `UpdateStimulusDraft`, `AttachStimulusToItem` — attachment pins the **stimulus version** current at attachment time (FR-TCH-03 rule 2)
- `CreateSolutionDraft`, `UpdateSolutionDraft` targeting a specific item version
- **Final-answer agreement (M3-14) is checked on every solution save**, not only at publication, so the author learns while the item is still in their head
- Each handler declares a policy; subject-scoped authoring is enforced (FR-TCH-01 rule 1 — a Chemistry author cannot author Physics content), and the negative path is tested
**Tests** Unit + integration: each command · attachment pins the version, and a later stimulus edit does not move it · solution save with a disagreeing final answer refused · out-of-subject authoring refused · 100%

### M3-27 · Media commands & the `MediaStore` port (DEC-6)
**Objective** FR-QM-06 — governed assets, with bytes outside the database.
**Files** `application/commands/media-commands.ts`, `application/handlers/media-handlers.ts`, `application/ports.ts`
**Acceptance**
- `RegisterMediaAsset`, `AddMediaAssetVersion`, `RetireMediaAsset`
- **`MediaStore` is a port** — `put(bytes) → { storageKey, checksum }`, `head(storageKey)`. The in-memory implementation is the test double; the real adapter is M0's, and swapping it is a wiring change
- The checksum is recorded at registration and re-verified before publication, so a replaced object is detectable
- Retirement refused while referenced by published content, using M3-24's count
- **No handler, DTO, route or event carries bytes**, asserted by a source scan over the context
**Tests** Unit + integration: register, version, retire · retirement refused while in use · checksum mismatch refused at publication · no byte-bearing field anywhere in the context, asserted · 100%

### M3-28 · Lifecycle commands & permission gates (DEC-1)
**Objective** FR-QM-01 rule 2 — explicit, permission-gated, audited. No implicit transitions.
**Files** `application/commands/lifecycle-commands.ts`, `application/handlers/lifecycle-handlers.ts`
**Acceptance**
- `SubmitForReview`, `WithdrawFromReview`, `RecordReviewDecision`, `PublishItemVersion`, `SuspendItem`, `RetireItem`, and the stimulus and solution equivalents
- **`PublishItemVersion` resolves every supplied fact M3-11 requires** — solution availability, reference counts, the render verdict, the licence's `asOf` instant — and passes them in. It decides nothing itself
- Submission locks the draft against author edits until review returns it (FR-TCH-08 rule 1); withdrawal is permitted before review begins and refused after (rule 2)
- **Every transition declares a distinct authorization policy**, and each negative path is tested — 100% on authorization negative paths is a handbook §5 requirement, not a target
- Every transition writes an audit record naming principal, action, target version and justification (INV-02)
- **This handler is correctness-bearing**: it resolves which version becomes the published one. 100% threshold added with the file
**Tests** Integration (real Postgres): each transition · publication refused for each unmet precondition, end to end · submission locks the draft · withdrawal after review begins refused · each transition refused for each unauthorized role · audit written per transition · 100%

### M3-29 · Content queries — two view families (DEC-4)
**Objective** Read models, and the boundary that keeps a key off a learner's screen.
**Files** `application/queries/authoring-queries.ts`, `application/queries/delivery-queries.ts`
**Acceptance**
- Authoring: `GetItemDraft`, `ListMyDrafts`, `GetItemVersionForAuthoring`, `GetValidationFindings`, `ListMediaAssets` — these **carry the key**, and only these
- Delivery: `GetPublishedItem`, `GetPublishedStimulus`, `GetPublishedSolution` — these carry **no key, no correct-option marker, no numeric expected value, no `is_correct` flag**, asserted per view by serializing a real view and scanning it, the M2-24 method
- A learner-role principal reaching an authoring query is `Authorization`, not an empty result — an empty result reads as "no such item" and teaches the wrong thing
- `GetPublishedSolution` is gated on entitlement separately from authorization (§8 — `Entitlement` is a distinct kind), and basic correctness is never gated (INV-08)
- Each query declares a policy
**Tests** Unit + integration: each query · answer-key absence asserted per delivery view over a serialized instance · a learner reaching an authoring query is refused with `Authorization` · a non-existent item returns `NotFound` · correctness never entitlement-gated · 100%

### M3-30 · Bulk import & rejection report (DEC-7)
**Objective** FR-TCH-11 and FR-QM-10 — volume without bypassing governance.
**Files** `application/import/import-batch.ts`, `application/handlers/import-handlers.ts`
**Acceptance**
- JSON Lines with a header record carrying batch identity, source and a licensing declaration every record inherits; an undeclared batch is refused outright (FR-QM-10 rule 2)
- **Records are validated through the same domain constructors the interactive path uses** — asserted by the import calling them, not by a parallel validator
- **Per-record outcome:** a valid record becomes a draft; an invalid one enters the report with line number, record identifier, error code and message. One bad record never fails the batch
- **Every imported record enters as `draft`** and carries provenance identifying the batch (FR-TCH-11 rules 1, 3) — asserted by a test that no import path can reach any other state
- Duplicate detection records `duplicateCheckState: 'deferred'` (DEC-7); the report says so rather than implying none were found
- The batch is transactional per record, not per file — a failure at record 400 does not roll back 399 good drafts
**Tests** Integration: a mixed batch imports the valid and reports the invalid · malformed header refused · undeclared licensing refused · a record failing each blocking validation appears with the right code · every imported record lands in `draft` · a mid-batch failure retains prior records · 100%

### M3-31 · Public barrel & boundary enforcement
**Objective** §9 rule 1, held to M1's and M2's standard.
**Files** `public/index.ts`
**Acceptance**
- Exports exactly commands, queries and events — no aggregate, repository or infrastructure type
- Value objects consumers need are re-exported as read-only DTO shapes, including **`ContentBody`, so M6 can render a pinned version and the renderer package can type against one**
- **`AnswerKeyData` is re-exported for M6's benefit** — M6 assembles attempts and needs the key — but the barrel documents in its own header that this export is server-side only and is never a client payload type
- Content imports curriculum and scoring **only** through their barrels, asserted by the boundary checker
- `domain/` imports nothing (F2), including nothing from either
- **An M4 seam spec** written against `content/public/` only, so M4 discovers a missing export as a compile failure rather than by reaching past the barrel — the M2→M3 seam's method, which found a real gap
**Tests** `boundary-rules.spec.ts` extended: planted violation reaching into `scoring/domain` caught · planted violation reaching into `curriculum/infrastructure` caught · planted `domain/` import caught · all four import forms per ADR-0002 · the M4 seam spec compiles and constructs a review-ready item from barrel types alone

### M3-32 · Domain events & outbox emission
**Objective** Cross-context effects, transactionally (§9 rule 4, P4).
**Files** `infrastructure/outbox-emitter.ts`
**Acceptance**
- Every M3-18 event emitted to `platform.outbox_message` **in the same transaction** as the aggregate write
- A rolled-back publication leaves no event — proven by rolling back, the M2-26 method
- Payload inspection for key material, body content and PII on every event type
**Tests** Integration: event row written in the same transaction · rollback leaves no event · F18 reconciliation · payload inspection per event type

---

## Track D — API

### M3-33 · OpenAPI contract & ADR-0009 (DEC-4)
**Objective** Contract first (§9 rule 15), and the answer-key boundary made enforceable.
**Files** `apps/api/src/contracts/content.openapi.yaml`, `packages/contracts/src/content.ts` · **plus `docs/adr/ADR-0009-authoring-dtos-carry-the-answer-key.md`**
**Acceptance**
- Every endpoint present with an `x-handler` reconciling against the registry (F15, the M1/M2 pattern)
- RFC 9457 Problem Details on every error, with a stable `code` and an explicit `retryable` flag (§8)
- **Two schema families, and the split asserted against the document itself**: every schema referenced from a non-`/v1/authoring/**` response is scanned for key-bearing fields and must have none; the authoring route list is enumerated in the spec and asserted to match the document
- Zod schemas generated from the document, not hand-written — closing **D18** for this context rather than repeating it
- The document validates against the OpenAPI 3.1 meta-schema — closing **D7** for this context
- **ADR-0009** records the divergence from the literal §9 rule 10 / F6 / F35 wording, the two-family design, and what enforcement replaces the blanket check. It carries DEC-4's three ratified conditions: the authoring route list is **enumerated and closed**; the check asserts **both directions**; and no `Authoring*` DTO is reachable from a delivery controller, asserted structurally
**Tests** Contract: spec/registry reconciliation · Problem Details on every error with `retryable` · key-bearing field absent from every delivery schema, asserted over the whole document · **present on every authoring schema that is supposed to carry one** · the enumerated authoring route list matches the document exactly, in both directions · 3.1 meta-schema validation

### M3-34 · Content controllers
**Objective** Controllers and DTOs. No business logic (§1).
**Files** `api/content.controller.ts`, `api/authoring.controller.ts`, `api/dto/content-schemas.ts`, `api/content.module.ts`
**Acceptance**
- Authoring routes under `/v1/authoring/`: items, item versions, stimuli, solutions, media, validation findings, import batches, and the lifecycle transitions
- Delivery routes: `GET /v1/items/{id}`, `GET /v1/stimuli/{id}`, `GET /v1/solutions/{id}`
- Paths plural and kebab-case; JSON fields camelCase (§2)
- Input validated at the boundary against the generated schemas; failures return `Validation` Problem Details
- Module boot fails if any handler lacks a policy (F36), proven with a planted policy-less handler
- Correlation ID on every response, error or not (§8)
- **A delivery route that would serialize a key fails a test, not a review** — the assertion runs against live controller output, not only against the document
**Tests** Integration: each route happy path · each error path returns Problem Details · malformed body rejected at the boundary · policy-less handler fails boot · correlation ID present · live delivery responses scanned for key material

---

## Track E — Rendering & Studio

### M3-35 · `packages/content-renderer/` — the one renderer (F20)
**Objective** §9 rule 13 / F20 — `ContentRenderer` has exactly one implementation. Two implementations mean the authoring preview diverges from what students see, silently violating INV-14.
**Files** `packages/content-renderer/package.json`, `src/content-renderer.tsx`, `src/surface-profile.ts`
**Acceptance**
- One exported `ContentRenderer` taking `{ body: ContentBody, surface: SurfaceProfile }`
- `SurfaceProfile`: `web | mobile | offline | print` — a **parameter**, not four components. This is what makes the byte-for-byte claim provable rather than aspirational
- Every node kind in the DEC-2 vocabulary renders; **an unknown kind renders a visible, labelled fallback and reports it**, never throws and never renders nothing
- Zero imports from `apps/learn` or `apps/studio` (F19); the package is consumed by both
- Semantic HTML: headings, lists and tables are real elements, and every figure carries its alt text
- No hardcoded colour outside the token layer (F24 / §9 rule 16)
**Tests** Component: each node kind renders, per surface profile · unknown kind renders the fallback and reports · axe scan clean on a representative document · no colour literal, asserted by source scan · F20 asserted by a monorepo-wide scan for a second implementation

### M3-36 · Mathematical notation → MathML
**Objective** ACC-02, and the reason Temml was chosen over KaTeX (TECH-STACK §1).
**Files** `packages/content-renderer/src/math-node.tsx`
**Acceptance**
- LaTeX → **real MathML**, not HTML-and-CSS that looks like mathematics
- **The authored `textAlternative` is emitted as the accessible name** on every expression — the library's own output is not trusted to produce a sensible reading order
- Rendering is deterministic: the same LaTeX yields byte-identical MathML across calls and across surface profiles
- Invalid LaTeX renders the text alternative with a visible error affordance and **reports the failure to the validation surface**, so FR-QM-14 rule 2 can block publication on it
- Long expressions scroll inside their own container; the body never scrolls horizontally (FRONTEND §9)
**Tests** Component: a representative expression per notation class renders MathML · accessible name equals the authored alternative · byte-identity across 100 renders and across all four profiles · invalid LaTeX degrades and reports · overflow container asserted · axe clean

### M3-37 · Chemical notation → MathML (DEC-6)
**Objective** Formulae, charges, states and equations, deterministically.
**Files** `packages/content-renderer/src/chem-node.tsx`
**Acceptance**
- Chemical notation renders through the same MathML pipeline: subscripts, superscripts, charges, state symbols, single and equilibrium arrows, stoichiometric coefficients
- The authored `textAlternative` is the accessible name, as for mathematics
- Deterministic and identical across surface profiles
- **Structural diagrams are out of scope and the deferral is explicit** (DEC-6): a notation string a chemistry author would expect to draw a structure renders the text alternative with a "use a diagram asset" affordance rather than a broken picture
**Tests** Component: each notation class renders · charges and states asserted · byte-identity across profiles · a structure-shaped input degrades to the documented affordance · axe clean

### M3-38 · Render validation across four surfaces
**Objective** The milestone's "preview matches student render byte-for-byte", and FR-QM-14.
**Files** `packages/content-renderer/src/render-validation.ts`, `render-validation.spec.tsx`
**Acceptance**
- `validateRender(body) → { surface, ok, failures[] }[]` across all four profiles
- **A render failure on any supported surface blocks publication** (FR-QM-14 rule 2) — this function produces the verdict M3-11 requires as a supplied fact
- **Byte-for-byte parity:** the Studio preview and the delivery render of the same document produce identical serialized output for the same surface profile, asserted over a fixture corpus covering every node kind
- Preview defaults to the **minimum device profile** (360 px), not desktop (FR-QM-14 rule 3, UX §10.1)
- Failures name the block index and the reason, so the validation panel can point at the problem
- A planted divergence between preview and delivery fails the suite
**Tests** Component: parity asserted per fixture per surface · a planted divergence caught · minimum profile is the default · a failing node blocks and names its location · the fixture corpus covers every node kind, asserted by enumeration against `BLOCK_KINDS` and `INLINE_KINDS`

### M3-39 · Studio shell, sidebar & the 1280 px gate (DEC-5, D3)
**Objective** Debt D3, scoped to what can exist without a running application.
**Files** `apps/studio/src/shell/StudioShell.tsx`, `src/shell/navigation.ts`, `src/shell/viewport-gate.tsx`
**Acceptance**
- Persistent left sidebar with the FRONTEND §2 destinations; the M3 surfaces are live and the rest are declared and disabled, not absent — a navigation model that grows by enabling is reviewable, one that grows by appearing is not
- **Below 1280 px the shell renders an explicit "use a larger screen" gate** and no authoring surface (FRONTEND §2, §9) — asserted at 1279 and 1280
- Command palette (⌘K) scaffolding with keyboard-first navigation through the destination list
- Focus moves to the main heading on destination change; the sidebar is fully keyboard-operable (FRONTEND §10)
- **No `main.tsx`, no Vite dev server, no router dependency** (DEC-5); the route table is a typed data structure the shell consumes
- Every destination has an accessible name; axe clean
**Tests** Component: gate renders below 1280 and does not above · destination change moves focus to the heading · keyboard traversal of the sidebar · palette opens and filters · disabled destinations are announced as disabled · axe clean

### M3-40 · Item Editor — dual-mode input, live preview, autosave
**Objective** One of the four pages that carry the product (FRONTEND §3).
**Files** `apps/studio/src/features/item-editor/ItemEditor.tsx`, `item-editor-model.ts`
**Acceptance**
- **Dual-mode notation input**: LaTeX text entry and a visual palette, **switchable mid-item without losing content** (UX §10.1) — the switch is asserted to be lossless in both directions
- **Live preview renders through `packages/content-renderer/` at mobile width by default** — the same component the student sees, which is what makes M3-38's parity claim mean anything
- Autosave with debounce, driven by M3-25's idempotent update; a save in flight never loses a keystroke typed during it
- Validation is continuous and inline, blocking only at submit (UX §10.1); findings name what is missing and where, never "invalid item"
- The answer key is edited here and nowhere else, and the surface is reachable only under an authoring policy
- Options are authored as `ContentBody`, so an option can carry an equation
- Every field programmatically labelled, errors bound via `aria-describedby`, error summary at the top with focus moved to it (FRONTEND §7)
- Distractor authoring prompts for the **misconception**, not just the wrong value (UX §10.1)
**Tests** Component: mode switch preserves content both ways · preview updates on edit and matches the delivery render · autosave debounces and does not lose in-flight keystrokes · each blocking finding surfaces inline with its location · submit refused with a blocking finding · labels and `aria-describedby` asserted · axe clean

### M3-41 · Stimulus & Solution editors
**Objective** FR-TCH-03 and FR-TCH-04 surfaces.
**Files** `apps/studio/src/features/stimulus-editor/`, `src/features/solution-editor/`
**Acceptance**
- **A stimulus is created and attached as a first-class object**, never pasted per item (UX §10.1) — the editor offers attach-existing before create-new, and the attach flow shows which items already reference it
- The solution editor shows the item and its key alongside, and **surfaces final-answer disagreement (M3-14) immediately**, not at submit
- Step ordering is drag-free and keyboard-operable — reordering by keyboard alone is asserted
- Distractor analysis is prompted per incorrect option, with the option's own body shown
**Tests** Component: attach-existing before create-new · reference list shown at attach · disagreeing final answer surfaces immediately · keyboard reordering of steps · per-option distractor prompts · axe clean

### M3-42 · Media library & alt-text enforcement
**Objective** FR-QM-06 at the surface that produces the content.
**Files** `apps/studio/src/features/media-library/`
**Acceptance**
- **Alt text cannot be skipped** — the register action is unavailable until it is present, rather than failing after upload
- A complex asset type additionally requires a long description before registration
- The usage graph is visible: which published content references this asset, from M3-24's count
- Retirement is refused in the UI *and* in the domain, and the UI states why rather than disabling silently
**Tests** Component: register disabled without alt text, enabled with it · long description required for complex types · usage list rendered · retirement refusal explained · axe clean

### M3-43 · Item browser & the validation panel
**Objective** The surface an author returns to, and where FR-TCH-07's findings live.
**Files** `apps/studio/src/features/item-browser/`
**Acceptance**
- Filter by lifecycle state, subject, concept and author; filters live in the URL (FRONTEND §5)
- **Drafts show only the author's own** (FR-TCH-06 rule 1), and the empty state is designed, not defaulted (UX §12)
- The validation panel groups findings as blocking and warning, each with its location, and states plainly that duplicate detection has not run (DEC-7)
- A published item's row shows its published version number and links to the version history with diffs (FR-QM-02 rule 4)
**Tests** Component: filters round-trip through the URL · another author's drafts absent · blocking and warning grouped separately · duplicate check reported as not evaluated · empty state rendered · version history reachable · axe clean

---

## Track F — Gates

### M3-44 · Fitness functions & coverage thresholds
**Objective** The gates this milestone adds and amends, each proven with a planted violation (the M1/M2 standard).
**Files** `apps/api/src/fitness/content-rules.ts`, `content-rules.spec.ts`, `apps/api/vitest.config.ts`, `apps/studio/vitest.config.ts`
**Acceptance**
- **F6 / F35, amended per ADR-0009, asserted in both directions** — no answer key, correct-option marker, numeric expected value or solution body in any delivery DTO, delivery view, event payload or non-authoring OpenAPI schema; **and** the key present on every authoring schema that is supposed to carry one, so the check fails on a silent removal as well as a silent addition. The authoring route list is an enumerated closed constant, asserted against the document. **No `Authoring*` DTO is reachable from a delivery controller**, asserted by import graph rather than by naming convention
- **F20** — exactly one `ContentRenderer` implementation across the monorepo, by scan
- **INV-01, structural** — no import path from any AI context into `contexts/content/`, and no publication path that accepts a non-human reviewer signature on AI-sourced provenance. Both proven against planted violations
- **INV-14** — no rendered-markup or image-of-text field anywhere in the content vocabulary, by scan
- **F5** — every content JSONB column has a version sibling, by catalogue query
- **F7 / F40** — no `UPDATE`/`DELETE` grant on published-version tables
- **F1, F2, F9, F15, F18, F36, F45, F46, F47, F48 still green** — the whole M1/M2 set re-run, not assumed
- **Coverage thresholds added per ADR-0008** for every correctness-bearing content module — M3-08 (the key projection), M3-11 (publication preconditions), M3-14 (final-answer agreement), M3-17 (validation), M3-10 (lifecycle), M3-28 (lifecycle handlers), M3-29 (queries), M3-21/22/23/24 (repositories) — and the gate verified **failing before it passes**
- `content-rules.spec.ts` polices its own list: it fails if an in-scope module has no threshold, if a threshold is below 100, or if a named module has been deleted without the list being updated
**Tests** Each check green on the real tree and red on its planted fixture, committed under `src/fitness-fixtures/` · thresholds asserted present for every in-scope module · the full M1/M2 fitness set re-run green

### M3-45 · Import corpus — 500 records with a rejection report
**Objective** The milestone's fifth acceptance criterion, as a real corpus.
**Files** `apps/api/src/testing/import/corpus-500.jsonl`, `import-corpus.spec.ts`
**Acceptance**
- 500 records, **generated deterministically from a seeded fixture builder** — a hand-written 500-line file is unreviewable and would rot
- The corpus deliberately includes every rejection class: missing tag, missing licensing, unresolved licensing, missing tolerance on a numeric item, unrenderable notation, missing solution, malformed record, unknown item type, duplicate option id
- **The rejection report is asserted exactly** — every expected rejection present with its code, and no unexpected rejection. "Correct rejection report" means the set matches, not that some records failed
- Valid records all land in `draft` and are retrievable
- The import completes within the per-commit test budget; if it cannot, the count is justified in the spec rather than quietly reduced
**Tests** Integration: 500 records import · the rejection set matches exactly, by code · every accepted record is a retrievable draft · a planted acceptance of a record that should be rejected fails the suite

---

## Sequencing

```
Week 1   A01→A08 (body, tags, provenance, licensing, spec, key projection)  ║ B19 (schema)      ║ DEC ratification
Week 2   A09→A14 (versions, item, preconditions, stimulus, solution)        ║ B20, B21          ║ E35, E36 (renderer, math)
Week 3   A15→A18 (media, locale, validation, events)                        ║ B22→B24 (repos)   ║ E37, E38 (chem, parity)
Week 4   C25→C29 (authoring, lifecycle, queries)                            ║ E39 (shell)       ║ E40 (item editor)
Week 5   C30→C32 (import, barrel, outbox) ║ D33, D34 (API)                  ║ E41→E43 (editors, library, browser)
Week 6   F44, F45 (gates, corpus)                                           ║ hardening         ║ close-out
```

**Critical path:** A01 → A02 → A07 → A08 → A09 → A10 → A11 → C28 → D34 (~19 days)
**Second path, nearly as long:** A02 → E35 → E36 → E38 → E40 (~17 days). **Start E35 in week 2, not week 4** —
M3-11's publication precondition consumes a render verdict, and M3-40's preview is the milestone's visible
deliverable. A renderer arriving in week 5 makes both of those late.
**Blocked:** nothing in M3. **B1 remains open and carried** — see below.

---

## Milestone Definition of Done

A task is done when merged with tests green. **The milestone** is done when all of the following hold:

- [ ] All 45 tasks merged
- [ ] `Item`, `Stimulus`, `Solution` and `MediaAsset` version independently, each with its own lifecycle
- [ ] **Publication is blocked without tags, provenance, resolved licensing, a solution, a reviewer signature and a valid answer specification** — every one proven by a failing publication, and every check in the domain
- [ ] **INV-12 self-review and INV-01 AI-never-publishes are structural**, each proven against a planted violation
- [ ] Published versions reject mutation via ORM **and** raw SQL
- [ ] **An `ItemVersion`'s response specification reaches the executor unchanged** — proven by scoring an attempt built from a projected key using `scoring/public/` alone
- [ ] **Preview matches the delivery render byte-for-byte** on the minimum device profile, across all four surfaces, over a fixture corpus covering every node kind
- [ ] `ContentRenderer` has exactly one implementation (F20); notation renders as real MathML with the authored text alternative as its accessible name
- [ ] Alt text is mandatory at construction and at the database; `content_media_ref` refuses retirement of an in-use asset
- [ ] **500 items imported with an exactly-matching rejection report**; every imported record enters as a draft
- [ ] **Answer keys and solutions absent from every delivery payload**, asserted over live controller output and the whole OpenAPI document; the authoring exception ratified in **ADR-0009** and enforced by an enumerated list
- [ ] Studio shell gates below 1280 px; the Item Editor autosaves, previews at mobile width, and switches notation mode losslessly
- [ ] Automated accessibility scan clean on every Studio surface
- [ ] Fitness functions F6/F35 (amended), F20, INV-01 and INV-14 green, each proven against a planted violation
- [ ] **F1, F2, F5, F9, F15, F18, F36, F45, F46, F47, F48 still green**
- [ ] **100% coverage on every correctness-bearing content module** per ADR-0008; ≥ 80% line / ≥ 70% branch overall
- [ ] `docs/tasks/M3-TRACEABILITY.md` maps every acceptance criterion to the test that proves it
- [ ] **"An author produces a stimulus-linked set in ≤ 20 min"** — **expected `Fail — blocked`** on D3/M0 (DEC-5). Reported as failed-blocked with the jsdom step count as the nearest available evidence, never as passed
- [ ] **B1 carried forward and restated** — M2-30, the golden set validated against zero real papers, remains blocked on [DECISIONS §D item 2](../DECISIONS.md) and legal counsel sign-off. It appears in the M3 close-out and in every handoff until it closes

---
