# M3 — Close-out

**Content Model & Authoring. 45 of 45 tasks merged.** Verified on 2026-08-12
against a real Postgres 16 on port 5433 (Homebrew, no Docker — ADR-0004).

Every number below is a run, not a recollection.

---

## Part 1 — Evidence

### Full suite

```
corepack pnpm -r typecheck                              4 projects, clean
corepack pnpm -r --workspace-concurrency=1 test
```

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 115 | **3199** |
| `apps/studio` | 12 | **252** |
| `packages/content-renderer` | 4 | **118** |
| `tools/seed` | 5 | **94** |

Zero failing, zero skipped-at-the-file-level, zero quarantined.

### Coverage

| Project | Line | Branch | Thresholds |
|---|---|---|---|
| `apps/api` | **91.44 %** | **97.46 %** | every one met, including 100 % on all 38 correctness-bearing content modules |
| `apps/studio` | **97.10 %** | **92.09 %** | 80 / 70 overall, met |

The `apps/studio` gate was **verified failing first** — raised to 99 % branches, it
errored with `Coverage for branches (92.09%) does not meet global threshold (99%)`,
then restored. The ADR-0008 list gate is verified failing three ways in
`content-rules.spec.ts`: a module with no threshold, a threshold below 100, and a
threshold naming a deleted module.

**A real defect fixed here:** `apps/studio` had `@vitest/coverage-v8@4.1.10`
against `vitest@3.2.7`. The provider could not load at all
(`does not provide an export named 'BaseCoverageProvider'`), so `--coverage` had
never run in Studio. Pinned to 3.2.7 from the store and wired into the test
script.

### Fitness checks

Each runs against the real tree **and** against a planted violation committed
under `src/fitness-fixtures/`.

| Gate | Green on the tree | Red on the fixture |
|---|---|---|
| F1 / F2 | `boundary-rules.spec.ts` | `as-content-boundary/`, `as-content-domain/` |
| F5 | `content-rules.integration.spec.ts` (catalogue query, ≥ 9 JSONB columns) | a real sibling removed from the rows |
| F6 / F35 (ADR-0009) | `content-rules.spec.ts`, both directions | `as-content-surface/planted-delivery-key.ts`, `planted-keyless-authoring.ts` |
| F7 / F40 | `content-rules.integration.spec.ts` | planted TRUNCATE grant rows |
| F20 | `content-rules.spec.ts`, 1 implementation, > 50 files scanned | `as-content-renderer/planted-second-renderer.ts` |
| INV-01 (structural) | clean across the content context | a stand-in context pattern over `as-content-domain/` |
| INV-01 (behavioural) | `checkNoMachinePublishesItsOwnContent` refuses | asserted directly, both signature kinds |
| INV-14 | both declarations of the vocabulary | `as-content-vocabulary/planted-rendered-markup.ts` |
| ADR-0009 condition 3 | import graph, 17 modules, 3 hops from the delivery controller | the authoring controller, which does reach the family |

**A real defect fixed at close-out:** the gate register in `content-rules.spec.ts`
asserted only that each M1/M2 gate's spec file *existed*. F9 named the curriculum
schema spec and F46 named the scoring-rules spec — both existed, so the register
was green while naming neither gate. It now asserts the named spec contains the
gate's own phrase, and that check is shown to fail.

### Migrations — up, down, up on a clean database

`content-schema.integration.spec.ts` › migrations run up, down and up again ·
`content-immutability.integration.spec.ts` › migrations run up, down and up again
with the triggers in place.

### Published-version immutability under raw SQL

`content-immutability.integration.spec.ts` proves UPDATE and DELETE refused on
nine tables once published, from raw `psql`-level statements rather than through
the ORM, and proves a draft version stays editable — the one difference from
scoring's blanket append-only rule, and the whole point of the draft state.

### The import corpus

500 records, generated deterministically and committed; the spec regenerates and
compares byte for byte. **488 imported, 12 rejected, rejection set matched
exactly by code**, and the exactness check is shown to fail in both directions.

**Two real defects the corpus found, fixed rather than expected:**

1. A `MATH_BLOCK` with a blank `textAlternative` **imported cleanly**. The parser
   fabricates a `ContentBody` from JSON by assertion, and nothing ran
   `createContentBody` — so import could create a draft the editor refuses, which
   is the one thing DEC-7 says it must not do, and put an equation with no reading
   order into the corpus. Every authored body now goes back through the domain
   constructor.
2. A numeric spec missing its tolerance was refused **by a database CHECK
   constraint**, reaching the report as `PERSISTENCE_REJECTED` carrying a raw
   Postgres message — SQL in a client payload (§8). `checkSpecificationIsScorable`
   now guards every write path, so DEC-3's "a specification whose projection the
   executor refuses cannot be saved" holds rather than being described.

### Golden set

```
golden set: 0 official paper(s), 4 synthetic
40 tests passed
```

**This is B1, and it is still open.** See Part 3.

---

## Part 2 — Traceability

[M3-TRACEABILITY.md](M3-TRACEABILITY.md) — **214 criteria · 205 ✅ · 9 ⚠️ · 0 ❌**,
with every ⚠️ named and mapped to its debt item.

---

## Part 3 — B1: CARRIED BLOCKING GATE

**M2-30 — the golden set is validated against zero real papers.**

The CI gate runs every commit and is **vacuous**: four synthetic fixtures, and
nothing about agreement with an official key. A scoring engine that agrees with
itself is not evidence.

- **Blocked on** [DECISIONS §D item 2](../DECISIONS.md) — content licensing and IP
  policy — which needs legal counsel.
- **The decision is one sentence:** may released papers with official NTA keys be
  held in this repository as internal test fixtures, not served to learners?
- **Acceptance:** three papers under `apps/api/src/testing/golden/papers/` with
  `provenance: "official"`, and the suite reporting `3 official`.
- **Do not attempt to source papers** until that decision is recorded.

It appears here and must appear in every handoff until it closes.

---

## Part 4 — Milestone Definition of Done, per item

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | All 45 tasks merged | **Pass** | 45 rows in [M3-PROGRESS.md](M3-PROGRESS.md); 45 commits |
| 2 | `Item`, `Stimulus`, `Solution`, `MediaAsset` version independently, each with its own lifecycle | **Pass** | four aggregates, four repositories, one shared lifecycle table; `item.spec.ts`, `stimulus.spec.ts`, `solution.spec.ts`, `media-asset.spec.ts` |
| 3 | Publication blocked without tags, provenance, resolved licensing, a solution, a reviewer signature and a valid answer specification — each proven by a failing publication, every check in the domain | **Pass** | `lifecycle-handlers.integration.spec.ts` › publication is refused for each unmet precondition — 12 tests, one per precondition, end to end |
| 4 | INV-12 self-review and INV-01 AI-never-publishes are structural, each proven against a planted violation | **Pass** | the offending decision is written straight to `content.review_decision`, so the guarantee does not rest on one code path; `content-rules.spec.ts` › INV-01 (both halves) |
| 5 | Published versions reject mutation via ORM **and** raw SQL | **Pass** | `content-immutability.integration.spec.ts`, nine tables, UPDATE and DELETE, parts frozen with their version |
| 6 | An `ItemVersion`'s response specification reaches the executor unchanged — proven by scoring an attempt built from a projected key using `scoring/public/` alone | **Pass** | `contexts/scoring/m3-seam.spec.ts` (9 tests) + `answer-key-projection.spec.ts` › projection produces a key the executor accepts |
| 7 | Preview matches the delivery render byte-for-byte on the minimum device profile, across all four surfaces, over a corpus covering every node kind | **Pass** | `render-validation.spec.tsx` › preview matches the delivery render, byte for byte; › the fixture corpus covers every node kind (enumerated against `BLOCK_KINDS`/`INLINE_KINDS`) |
| 8 | `ContentRenderer` has exactly one implementation; notation renders as real MathML with the authored alternative as its accessible name | **Pass** | `content-rules.spec.ts` › F20 (1 implementation, > 50 files scanned); `math-node.spec.tsx`, `chem-node.spec.tsx` |
| 9 | Alt text mandatory at construction and at the database; `content_media_ref` refuses retirement of an in-use asset | **Pass** | `media-asset.spec.ts` › alt text is required at construction; `content-schema.integration.spec.ts` › ACC-03; `media-asset.repository.integration.spec.ts` › the usage graph FR-QM-06 rule 3 consumes |
| 10 | 500 items imported with an exactly-matching rejection report; every imported record enters as a draft | **Pass** | `import-corpus.integration.spec.ts` — 500 read, 488 imported, 12 rejected, set matched by code, every accepted record a retrievable draft |
| 11 | Answer keys and solutions absent from every delivery payload, asserted over live controller output and the whole OpenAPI document; the authoring exception ratified in ADR-0009 and enforced by an enumerated list | **Pass** | `content.controller.integration.spec.ts` › a delivery response carries no key material, over live output; `content-contract.spec.ts` › ADR-0009 conditions 1–3; `content-rules.spec.ts` › F6/F35 |
| 12 | Studio shell gates below 1280 px; the Item Editor autosaves, previews at mobile width, and switches notation mode losslessly | **Pass** | `StudioShell.spec.tsx` › the 1280 px gate (asserted at 1279 and 1280); `ItemEditor.spec.tsx` › autosave, › the live preview is the delivery render, › dual-mode notation input |
| 13 | Automated accessibility scan clean on every Studio surface | **Pass** | `accessibilityViolations` runs in all 10 Studio spec files — 8 features, the shell, and the item editor's five states |
| 14 | Fitness functions F6/F35 (amended), F20, INV-01 and INV-14 green, each proven against a planted violation | **Pass** | the table in Part 1 |
| 15 | F1, F2, F5, F9, F15, F18, F36, F45, F46, F47, F48 still green | **Pass** | all run in the same suite; the register in `content-rules.spec.ts` now asserts each named spec actually contains its gate |
| 16 | 100 % coverage on every correctness-bearing content module per ADR-0008; ≥ 80 % line / ≥ 70 % branch overall | **Pass** | 38 modules at 100 %; overall 91.44 % line / 97.46 % branch |
| 17 | `M3-TRACEABILITY.md` maps every acceptance criterion to the test that proves it | **Pass** | [M3-TRACEABILITY.md](M3-TRACEABILITY.md), 214 criteria |
| 18 | "An author produces a stimulus-linked set in ≤ 20 min" | **Fail — blocked** | *expected*, per DEC-5. There is no running application to put in front of an author. jsdom evidence: **10 discrete steps** end to end — search, search, select, attach, stem, two options, mark correct, misconception, submit — across **16 interactive controls** on the Item Editor surface. Blocked on **D3 / M0** |
| 19 | B1 carried forward and restated | **Pass** (the gate itself remains **open**) | Part 3 above |

**18 of 19 pass. The one failure is the one the milestone predicted.**

---

## Part 5 — Debt register

### Added by M3

| # | Item | Owner | Trigger |
|---|---|---|---|
| **D19** | Chemical **structure** diagram rendering (DEC-6) | Frontend | The first `ChemBlock` degradation a chemistry SME reports as a defect rather than a choice |
| **D20** | ROADMAP M4 still lists the lifecycle machine as M4's; ADR-0010 records the divergence | Architecture | Next doc revision |
| **D21** | `content_licensing.owner_type` excludes `solution_version` | Data | If licensed third-party solutions are acquired |
| **D22** | The idempotency store is process-local; a retry on another instance is a redundant rewrite | Platform | M0's durable store |
| **D23** | The authoring **subject is declared on the command**, not cross-checked against the content — `curriculum/public/` exposes no concept→subject-domain lookup | Curriculum | When Curriculum exposes one |
| **D24** | No publication precondition requires a **pinned stimulus to be published**, so a published item can name a draft passage | Content | Next publication-rules revision |
| **D25** | A published item **cannot be revised at all** (`addVersion` refuses past draft), so `supersedesItemVersionId` has no producer | Content | The first upheld answer-key challenge needing a corrected version |
| **D26** | TECH-STACK names **Temml**; it is not in the dependency tree, so an in-repo converter stands in behind `latex-to-mathml.ts` | Frontend | The first authored expression its subset cannot express |
| **D27** | **`RenderValidator` has no production adapter** — calling `validateRender` from the API needs a composition root. The precondition is enforced today against a fact only a test supplies | Platform | M0's composition root |
| **D28** | A repository constraint violation reaches the caller as `PERSISTENCE_REJECTED` carrying the **raw Postgres message** — SQL in a response (§8). M3-45 removed the one path that reached it in practice; the mapping itself is untouched | Backend | The next constraint a user can trip |

### Carried, unchanged

**D7** — OpenAPI 3.1 meta-schema validation is **not closed** for content; the
meta-schema is not obtainable here and what ships is a strictly weaker structural
check, named as such in its own describe block.

**D18** — **closed for content**: Zod is generated from the document and compared
byte for byte.

**D2, D3, D10** — Playwright E2E, the Studio app shell/router/build, and
browser-measured p95 — remain deferred and are explicitly touched by DEC-5. D10
grew a second instance at M3-42: M1's `TaxonomyBrowser` performance test asserted
a 200 ms wall clock inside a shared jsdom worker pool, so it measured contention
and failed once the suite grew. It now compares four times the nodes against a
baseline and asserts linear rather than quadratic expansion. The real budget is
still a browser measurement.

D1, D4–D6, D8, D9, D11–D17 unchanged.

---

## Part 6 — What M3 does not give you

- **No running application.** No `main.ts`, no `main.tsx`, no Vite dev server, no
  Compose, no CI. Nothing calls the content context outside tests. That is DEC-5,
  ratified, and it is why item 18 above is a documented failure rather than a
  surprise.
- **No review workspace.** Assignment, ageing, batching and the reviewer's screen
  are M4's. M3 delivers the precondition, the state machine, and the record a
  decision is written to.
- **No validated golden set.** See Part 3.
