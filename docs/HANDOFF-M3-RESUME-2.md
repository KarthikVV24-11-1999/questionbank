# Handoff — M3 in progress, resume at M3-39

**State as of 2026-08-12.** M3 (Content Model & Authoring) is **38 of 45 tasks
merged**. Tracks A (domain), B (data), C (application) and D (API) are
complete. Track E (renderer & Studio) is 4 of 9.

**Green at HEAD (`d530686`):** `pnpm -r typecheck` clean ·
apps/api **3136 tests / 112 files** · packages/content-renderer **118 / 4** ·
apps/studio **91 / 4** · tools/seed **94 / 5** · coverage 91.24% line /
97.46% branch with every threshold met · golden set 40 pass, **0 official
papers, 4 synthetic**.

Supersedes [HANDOFF-M3-RESUME.md](HANDOFF-M3-RESUME.md), which remains
accurate for everything up to M3-24.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M3-CONTENT-MODEL.md](tasks/M3-CONTENT-MODEL.md) | **The whole Decisions section**, then the entry for the task you are on |
| [tasks/M3-PROGRESS.md](tasks/M3-PROGRESS.md) | The 38 rows — they record *why* things are shaped the way they are |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §5 testing, §8 error handling, §9 architecture rules |
| [adr/ADR-0008](adr/ADR-0008-coverage-follows-correctness-bearing-code.md), [adr/ADR-0009](adr/ADR-0009-authoring-dtos-carry-the-answer-key.md), [adr/ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) | The three M3 owns |
| [FRS.md](FRS.md), [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) | Per task only |

Do not re-read the full document set per task.

---

## Where to start: **M3-39 is written but not finished**

`apps/studio/src/shell/` is **untracked and uncommitted**. Four files exist:
`navigation.ts`, `viewport-gate.tsx`, `StudioShell.tsx`, `StudioShell.spec.tsx`.
`pnpm -r typecheck` passes. **25 of 27 shell tests pass; 2 fail**, and the fix
for both was identified but not applied:

1. **`is fully keyboard-operable, including the disabled destinations`** — the
   shell focuses the `<h1>`, which sits in `main`, *after* the sidebar in DOM
   order, so `user.tab()` walks forward past everything. Fix: release focus
   first — `(document.activeElement as HTMLElement | null)?.blur();` — before
   the first `await user.tab()`, with a comment saying why.
2. **`imports no router and declares no application entry point`** — the spec
   used `new URL('./file', import.meta.url)`, which Vite rewrites to a served
   path, so `readFileSync` gets `/src/shell/StudioShell.tsx`. Fix: read via
   `resolve('src/shell', file)` from `node:path` (studio's vitest runs with
   cwd = `apps/studio`), and assert `src/main.tsx`, `index.html` and
   `vite.config.ts` all do not exist — DEC-5 asserted rather than remembered.

Then run the shell spec, the full suite, append the M3-39 row to
`M3-PROGRESS.md`, commit, and continue to M3-40.

---

## Remaining tasks

**Track E (5):** M3-39 Studio shell (in flight) · M3-40 Item Editor ·
M3-41 stimulus & solution editors · M3-42 media library · M3-43 item browser
**Track F (2):** M3-44 fitness functions & coverage thresholds ·
M3-45 import corpus, 500 records

Then the **Milestone Definition of Done** at the end of
`tasks/M3-CONTENT-MODEL.md`: run it, report each item pass/fail with real
evidence, then stop.

---

## Running things

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

`pnpm` is not on PATH — use `corepack pnpm`. Postgres is Homebrew on **port
5433**, superuser `postgres`, databases `questionbank` and
`questionbank_test`; **no Docker on this machine** (ADR-0004). There is **no
network**: `corepack pnpm install --offline` resolves from the store, and
anything not already in `node_modules/.pnpm` cannot be added.

Studio and the renderer are separate vitest projects — run them from their own
directories (`cd apps/studio && corepack pnpm vitest run src/shell`).

---

## What exists now, beyond the first handoff

### Track C — application (M3-25 … M3-32)

`application/` holds `authorization.ts`, `handler-registry.ts`, `ports.ts`,
`commands/`, `handlers/`, `queries/`, `import/`. Twenty-plus handlers, each
with a policy; the registry throws at boot without one (F36).

- **Autosave edits the draft version in place** (`replaceDraftVersion`), on an
  `idempotencyKey`. A *revision* after review is `deriveDraft` + `addVersion`.
- **All four repositories rewrite an unpublished version and skip a published
  one**, reconciling options, tags, provenance, licensing, steps, analyses and
  media edges. They previously skipped *any* existing version, so an edited
  draft never persisted.
- `save(aggregate, events)` — **events are written in the aggregate's
  transaction** (§9 rule 4). A refused publication leaves no event.
- **`content.review_decision`** (added at M3-28) is the evidence M3-11's
  signature precondition consumes. Append-only; `findApprovalFor` returns the
  most recent *approving* decision; returned work must carry a justification,
  in the constructor and as a CHECK.
- Two query families (DEC-4). Delivery views are built **field by field**, so
  the matching pairing, the numeric expected value and every correct-option
  marker are simply never read.
- Import is JSON Lines with a mandatory header whose licensing every record
  inherits; records go through the **same domain constructors** as the
  interactive path, so the rejection codes are the domain's own.

### Track D — API (M3-33, M3-34)

`packages/contracts/openapi/content.yaml` — 37 operations, `x-handler` on each.
`scripts/generate-zod.mjs` derives `src/content-schemas.ts`; the contract spec
regenerates into a temp file and compares byte for byte.
`api/` holds `authoring.controller.ts` (34 routes), `content.controller.ts`
(3), `content.module.ts`, `http-runner.ts`, `problem-details.ts`, and **two
separate DTO modules** so ADR-0009 condition 3 holds by import rather than by
naming.

### Track E — renderer (M3-35 … M3-38)

`packages/content-renderer/` — one `ContentRenderer`, surface as a parameter,
real MathML for both notation classes, `validateRender` across four surfaces.
The node vocabulary is declared **in the package**; `apps/api`'s
`renderer-seam.spec.ts` fails if either side drifts.

---

## Conventions that must continue

Everything in the first handoff still holds. Added since:

1. **A test must be able to fail.** Every scan asserts it scanned something;
   every parity check is shown to fail on a planted divergence first.
2. **Delivery views name their fields one at a time.** Never spread a domain
   object and delete what should not be there.
3. **Ports over adapters.** `MediaStore`, `RenderValidator`, `ReviewProgress`,
   `Entitlements`, `IdempotencyStore`, `AuditRecorder` — in-memory doubles
   ship, real adapters are M0's or M4's, and each says so at the port.
4. **An unreachable branch is deleted, not tested.** Several were removed once
   the domain proved the condition first.
5. **Where a document cannot be honoured, say so in the spec.** D7's structural
   check lives in a describe block named "this is not the meta-schema".

---

## Carried forward

### B1 — blocking gate, still open

**M2-30: the golden set is validated against zero real papers.** The CI gate
runs every commit and is **vacuous** — 4 synthetic fixtures, nothing about
agreement with an official key. Blocked on [DECISIONS §D item 2](DECISIONS.md)
(content licensing & IP policy), needing legal counsel. The decision is one
sentence: *may released papers with official NTA keys be held in the repository
as internal test fixtures, not served to learners?* Acceptance: three papers
under `apps/api/src/testing/golden/papers/` with `provenance: "official"`, and
the suite reporting `3 official`. **Do not attempt to source papers.** Must
appear in the M3 close-out and every handoff until resolved.

### Debt added by M3

| # | Item | Trigger |
|---|---|---|
| **D19** | Chemical **structure** diagram rendering (DEC-6) | The first `ChemBlock` degradation a chemistry SME reports as a defect rather than a choice |
| **D20** | ROADMAP M4 still lists the lifecycle machine as M4's; ADR-0010 records the divergence | Next doc revision |
| **D21** | `content_licensing.owner_type` excludes `solution_version` | If licensed third-party solutions are acquired |
| **D22** | The idempotency store is process-local; a retry on another instance is a redundant rewrite | M0's durable store |
| **D23** | The authoring **subject is declared on the command**, not cross-checked against the content — `curriculum/public/` exposes no concept→subject-domain lookup | When Curriculum exposes one |
| **D24** | No publication precondition requires a **pinned stimulus to be published**, so a published item can name a draft passage | Next publication-rules revision |
| **D25** | A published item **cannot be revised at all** (`addVersion` refuses past draft), so `supersedesItemVersionId` has no producer | The first upheld answer-key challenge needing a corrected version |
| **D26** | TECH-STACK names **Temml**; it is not in the dependency tree, so an in-repo converter stands in behind `latex-to-mathml.ts` | The first authored expression its subset cannot express |
| **D27** | **`RenderValidator` has no production adapter** — calling `validateRender` from the API needs a composition root. The precondition is enforced today against a fact only a test supplies | M0's composition root |
| **D7** | OpenAPI **3.1 meta-schema validation is NOT closed** for content. The official meta-schema is not in the dependency tree; what ships is a strictly weaker structural check, named as such | When the meta-schema is obtainable |
| **D18** | **Closed for content.** Zod is generated from the document and compared byte for byte | — |

D1–D18 from M2 are otherwise unchanged. D2, D3 and D10 (Playwright, Studio
shell/router, browser-measured p95) are explicitly touched by DEC-5.

---

## What M3 still does not give you

- No running application: no `main.ts`, no `main.tsx`, no Vite dev server, no
  Compose, no CI. Nothing calls the content context outside tests.
- No Studio authoring surfaces yet (M3-40 … M3-43).
- No fitness-function module for content (M3-44) — the checks written so far
  live in the specs that needed them.
- **No validated golden set.** See B1.
