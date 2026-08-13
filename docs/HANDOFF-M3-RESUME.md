# Handoff — M3 in progress, resume at M3-25

**State as of 2026-08-10.** M3 (Content Model & Authoring) is **24 of 45 tasks
complete**. Tracks A (domain) and B (data) are finished. Track C (application)
has not started.

**2678 tests pass across 93 files. `pnpm -r typecheck` is clean. Coverage
91.54% line / 97.01% branch overall, with 23 content modules pinned at 100%.**

The task breakdown is [tasks/M3-CONTENT-MODEL.md](tasks/M3-CONTENT-MODEL.md) —
**approved, with seven ratified decisions and three amendments**. Per-task
evidence is in [tasks/M3-PROGRESS.md](tasks/M3-PROGRESS.md), one row per task.

---

## Where to start

**M3-25 — Item authoring commands, handlers & autosave.** Read its entry in the
task breakdown. Then M3-26 onward, in order.

Everything the domain and the database need is in place. Track C wires
commands and handlers on top of aggregates that already refuse what they should
refuse.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M3-CONTENT-MODEL.md](tasks/M3-CONTENT-MODEL.md) | **The whole Decisions section**, then the entry for the task you are on |
| [tasks/M3-PROGRESS.md](tasks/M3-PROGRESS.md) | The 24 rows — they record *why* several things are shaped the way they are |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §5 testing, §8 error handling, §9 architecture rules |
| [adr/ADR-0008](adr/ADR-0008-coverage-follows-correctness-bearing-code.md) | The coverage rule M3 inherits |
| [adr/ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) | Written this milestone — why the lifecycle is M3's, not M4's |
| [FRS.md](FRS.md) | FR-TCH-\* and FR-QM-\*, for the task you are on |

Do not re-read the full document set per task. The sections above are the
standing rules.

---

## Running things

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

`pnpm` is not on PATH; `corepack pnpm` works everywhere. Root `pnpm seed`
shells out to a bare `pnpm`, so use
`corepack pnpm --filter @questionbank/seed run seed`.

**The Postgres cluster was rebuilt during this milestone.** The Homebrew data
directory `/opt/homebrew/var/postgresql@16` had vanished; a fresh cluster was
initialised on **port 5433** with superuser `postgres`, and both
`questionbank` and `questionbank_test` recreated. Nothing was overwritten —
there was nothing there. If seed data is needed, run the seed command above;
the curriculum taxonomies and profiles reload idempotently.

Integration specs create and drop the `content`, `curriculum`, `scoring` and
`platform` schemas, so point them at a throwaway database
([ADR-0004](adr/ADR-0004-local-postgres-pending-m0-compose.md)).

---

## The seven ratified decisions

These were approved before M3-01 and **bind on everything remaining**. Full
text in the task breakdown; this is the operative summary.

| # | Decision | What it means for Track C onward |
|---|---|---|
| **DEC-1** | M3 owns the lifecycle state machine and every publication precondition, in the domain. M4 owns the *workspace* | M3-28's handlers drive an existing machine. They resolve facts and pass them in; they decide nothing. **[ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) is written** |
| **DEC-2** | `ContentBody` is a closed, versioned node vocabulary; `textAlternative` mandatory on every math/chem node, **enforced in the constructor** | Adding a node kind is a reviewed change in `content-body.ts` *and* the renderer, plus a `schemaVersion` bump |
| **DEC-3** | The answer key lives on `ItemVersion.responseSpec`; a one-way projection validates it through `scoring/public/` | Never hand-check a key. `projectAnswerKey` / `projectValidatedAnswerKey` are the only paths |
| **DEC-4** ⚠️ | Two DTO families — `Authoring*` carries the key, `Delivery*` never does. **Needs ADR-0009 at M3-33** | Three ratified conditions: the authoring route list is **enumerated and closed**; the fitness check asserts **both directions**; **no `Authoring*` DTO is reachable from a delivery controller**, asserted by import graph, not naming convention |
| **DEC-5** | Studio ships as jsdom-tested shell + surfaces. No `main.tsx`, no Vite dev server, no router dependency | "Author produces a set in ≤ 20 min" is reported **failed-blocked** on D3/M0 at close-out, never as passed |
| **DEC-6** | Chemical *notation* renders through the MathML pipeline; chemical *structures* are `MediaAsset` diagrams | Structure-diagram rendering is debt **D19** with a named trigger — see below |
| **DEC-7** | Bulk import is JSON Lines with a batch header carrying inherited licensing; records validated through the **same domain constructors** as the interactive path | Duplicate detection reports `not_evaluated`, never "none found" |

**Standing instruction attached to every task:** the answer key is the asset M3
introduces that can actually harm someone if it leaks. Where a choice is
between convenience and keeping keys off delivery payloads, take the second —
without asking.

---

## What exists now

### Track A — domain, 18/18 (`apps/api/src/contexts/content/domain/`)

| Module | Carries |
|---|---|
| `result.ts`, `content-error.ts` | Typed results; five error kinds narrowed from the platform ten. `ContentError` carries an optional **`location`** — every failure names where the problem is |
| `content-body.ts` | Six block kinds, four inline kinds, both closed. Rendered markup refused by shape |
| `content-body-projections.ts` | `plainText`, `notationTerms`, `referencedMediaIds` — derived, never authored |
| `taxonomy-tag.ts` | Tags bound to a taxonomy version; exactly one primary |
| `provenance.ts` | Closed source types; AI fields required on AI sources and refused on human ones |
| `licensing-status.ts` | `unresolved` is the draft default; expiry inclusive; instant supplied |
| `response-specification.ts` | Four item types, closed. Option bodies are `ContentBody`, not strings |
| `item-version.ts` | Immutable, no mutator. `deriveDraft` produces successors |
| `item.ts`, `item-lifecycle.ts` | Eight states as a table; 72-cell matrix swept, 13 legal |
| `publication-preconditions.ts` | INV-07, INV-12, INV-01, INV-14. All failures reported at once |
| `stimulus.ts`, `solution.ts`, `media-asset.ts` | Independently versioned aggregates sharing the one lifecycle table |
| `locale-variant.ts` | Modeled, **consumed by nothing** — two specs keep it that way |
| `pre-submission-validation.ts` | FR-TCH-07 blocking/warning sets, disjoint and exhaustive |
| `events/content-events.ts` | Six past-tense events, identifiers only; F18 registry |
| `repository-ports.ts` | Four repository interfaces |

`application/answer-key-projection.ts` and `application/final-answer-agreement.ts`
sit in `application/` because they reach `scoring/public/` and `domain/` imports
nothing.

### Track B — data, 6/6

- `infra/migrations/20260810100000_content_schema.sql` — 20 tables
- `infra/migrations/20260810110000_content_immutability.sql` — 15 triggers
- `infrastructure/schema.ts` (Drizzle mirror) and four repositories

**The immutability model is not scoring's.** A content version is editable
while a draft and immutable from publication, keyed on `published_at`. The test
is *ever* published, not *currently* published. A version's **parts freeze with
it** — options, tags, provenance, numeric spec, steps, media edges, licensing —
because otherwise a published item's answer key could be edited without
touching the row that claims to be immutable.

---

## Conventions that must continue

These are established and tested. Breaking one silently is worse than not
having it.

1. **`domain/` imports nothing.** Anything reaching `scoring/public/` or
   `curriculum/public/` lives in `application/`.
2. **Domain and application return typed `Result`s. Only infrastructure throws.**
   A domain function that throws is a defect — one was found and fixed at M3-11.
3. **Every validation failure carries a `location`.** "Invalid item" is a
   message an author cannot act on.
4. **Closed vocabularies are `as const` tuples with a type guard**, and adding a
   member is a reviewed code change.
5. **Projections are recomputed on save, never accepted from a caller.**
6. **Decimal literals cross as text, everywhere.** `0.1` and `0.1000` must stay
   distinguishable through storage and through the seam.
7. **No dead branches.** Several were found and removed rather than tested —
   an unreachable `??` fallback, a redundant `createAnswerKey`, a `finally` with
   an unreachable abrupt-completion path, a guard reconstitution already made.
   If a branch cannot be reached, delete it; if it can, test it.
8. **Coverage thresholds land in `vitest.config.ts` with the module**, not after.
9. **Repositories arm what the database enforces.** A trigger nothing sets is a
   guarantee against `psql` and not against the application — see below.

---

## Widenings made to `scoring/public/`

M3 needed three things the M2 barrel did not export. Each is documented at the
export site with why.

| Export | Why |
|---|---|
| `KEY_KIND_BY_ITEM_TYPE`, `isKnownItemType`, `KnownItemType` | Content owns the other end of the item-type vocabulary and must prove the two agree (DEC-3's amendment: a test failing on **either** side drifting) |
| `evaluateExactMatch` (scoring's `evaluateExactness`), `ConditionOutcome` | M3-14 must decide "does the solution's answer match the key" with the executor's own comparison — tolerance, units, accepted forms all apply as they will at scoring time |

`m3-seam.spec.ts` still compiles against the barrel only. Keep it that way.

---

## Defects found and fixed — do not reintroduce

| Defect | Where | Fix |
|---|---|---|
| F1/F2 boundary checker read **doc comments** as imports | `fitness/boundary-rules.ts` | Comments stripped before any guard reads a file |
| The same scanner read **string literals** as imports (`'…came from'` → import of `", "`) | same | Import pattern cannot cross a quote or semicolon before `from` |
| `boundary-rules.ts` held a **duplicate copy** of the patterns, so the gate and its own test disagreed | same | Collapsed to one implementation in `fitness/source-scan.ts` |
| `checkPublishable` **threw** when provenance was absent | `publication-preconditions.ts` | Guarded; the domain returns |
| Repository inserted a published item **before its version existed**, tripping a non-deferrable CHECK | `item.repository.ts` | State and published version move together, last |
| **No repository set `published_at`**, so the immutability trigger never armed for application writes — a published item's key was editable through the repository | all four repositories | Stamped on publish, only while NULL |
| `jsonb` does not preserve key order — a byte-identity assertion was wrong | `item.repository.integration.spec.ts` | Assert the document, not the serialization. **Anything needing a stable serialization must not read it from a jsonb column** |

---

## Remaining 21 tasks

Specs are in the task breakdown. Ordering is the dependency graph.

**Track C — application (8):** M3-25 authoring commands & autosave · M3-26
stimulus & solution commands · M3-27 media commands and the `MediaStore` port ·
M3-28 lifecycle commands & permission gates · M3-29 queries, **two view
families** · M3-30 bulk import · M3-31 public barrel & boundary enforcement ·
M3-32 events & outbox emission

**Track D — API (2):** M3-33 OpenAPI contract & **ADR-0009** · M3-34 controllers

**Track E — renderer & Studio (9):** M3-35 `packages/content-renderer/` ·
M3-36 math → MathML · M3-37 chemical notation · M3-38 render validation across
four surfaces · M3-39 Studio shell & 1280 px gate · M3-40 Item Editor ·
M3-41 stimulus & solution editors · M3-42 media library · M3-43 item browser

**Track F — gates (2):** M3-44 fitness functions & coverage thresholds ·
M3-45 import corpus, 500 records

### Things Track C will need that already exist

- `arePublicationPreconditionsSatisfied(item, version, facts)` — M3-28 resolves
  the facts (solution availability, render verdict, `asOf`, key acceptance) and
  passes them in. It **decides nothing**.
- `solutionAgreesWithKey(solutionVersion, spec)` — the `agreesWithKey` fact.
- `ItemRepository.countPublishedItemsUsingStimulusVersion` — FR-TCH-03 rule 3.
- `MediaAssetRepository.countReferencingPublishedContent` — FR-QM-06 rule 3.
- `validateDraft(version, facts)` — FR-TCH-07, for the authoring surface.

`application/authorization.ts` and `application/handler-registry.ts` do **not**
exist for content yet. M3-25/M3-28 need them; mirror scoring's (F36: a
policy-less handler fails module boot, proven with a planted violation).

---

## Per-task loop

1. Read that task's spec entry and only the doc sections it depends on.
2. Implement. Touch only files that task requires.
3. Write a test for every acceptance criterion.
4. Run the tests. Paste real output. Never claim a pass you did not see.
5. Self-review against the acceptance criteria and handbook §10.
6. Commit: `feat(content): <imperative subject>`. **Any commit touching an
   answer key, a response specification or anything the executor consumes must
   state the golden-set result in the body** (handbook §4).
7. Append one line to `docs/tasks/M3-PROGRESS.md`: task ID, date, test count,
   one-line note.
8. Start the next task immediately.

**Response per task: maximum 8 lines.** Task ID and name · files changed ·
tests added · test result with real totals · anything deferred.

---

## Quality bar — non-negotiable

- `domain/` imports nothing. Ever.
- Domain and application return typed Results; only infrastructure faults throw.
- Integration tests use real Postgres, never a mock.
- A failing or skipped test blocks the task. No quarantine.
- F1, F2, F5, F9, F15, F18, F36, F45, F46, F47, F48 stay green.
- ≥80% line, ≥70% branch overall; **100% on every correctness-bearing module**
  per ADR-0008. Add the threshold as each module lands.
- Consume M2 only through `contexts/scoring/public/`, M1 only through
  `contexts/curriculum/public/`.
- An `ItemVersion`'s response specification must reach the executor unchanged.
- **Answer keys and solutions never reach a client payload** (§9 rule 10). The
  authoring surface is the one place a key is edited; assert the boundary.
- INV-01 is structural: no code path from a model to a published item.
- Publication preconditions are enforced in the domain, not in the UI.

### Stop and ask only if

- a task's acceptance criteria contradict an approved document
- completing it requires violating a handbook §9 rule
- a design decision it depends on is genuinely absent from the docs
- a test failure reveals a flaw in the design rather than the code

Otherwise keep going.

---

## Carried forward

### B1 — blocking gate, still open

**M3-30 is not it. B1 is M2-30: the golden set is validated against zero real
papers.** The CI gate runs on every commit and is **vacuous** — it proves
regression-freedom against 4 synthetic fixtures and nothing about agreement
with an official key. Blocked on [DECISIONS §D item 2](DECISIONS.md) (content
licensing & IP policy), which needs legal counsel sign-off. The decision needed
is one sentence: *may released papers with official NTA keys be held in the
repository as internal test fixtures, not served to learners?*

Acceptance: three papers under `apps/api/src/testing/golden/papers/` with
`provenance: "official"` and a `source`, and the suite reporting `3 official`.
A pure data drop — no code change. **Do not attempt to source papers.**

**Must appear in the M3 close-out and every handoff until resolved.**

### Debt added by M3 so far

| # | Item | Trigger |
|---|---|---|
| **D19** | Chemical **structure** diagram rendering (DEC-6). Notation renders through MathML; structures are uploaded `MediaAsset` diagrams | The first authored item a chemistry SME rejects because an uploaded diagram cannot express what a generated structure would — i.e. the first `ChemBlock` degradation affordance that reaches a reviewer as a defect rather than a choice |
| **D20** | ROADMAP M4 still lists the lifecycle state machine as an M4 deliverable. ADR-0010 records the divergence; the ROADMAP edit follows it | Next doc revision |
| **D21** | `content_licensing.owner_type` excludes `solution_version` — a solution carries no licence of its own. Revisit if a licensed third-party explanation is ever ingested | If licensed solutions are acquired |

D1–D18 from M2 are unchanged and still carried; D2, D3 and D10 (Playwright,
Studio shell/router, browser-measured p95) are explicitly touched by DEC-5.

---

## What M3 does not give you yet

- No running application. Still no `main.ts`, no HTTP bootstrap, no Compose,
  no CI. Nothing calls the content context outside tests.
- No commands, handlers, authorization or barrel for content — Track C.
- No renderer package, no Studio surfaces — Track E.
- No answer-key boundary enforcement at an API layer — that arrives with
  ADR-0009 at M3-33 and its fitness check at M3-44.
- **No validated golden set.** See B1.
