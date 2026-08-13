# Handoff — M3 closed, M4 not yet started

**State as of 2026-08-12, HEAD `25435d5`.** M3 (Content Model & Authoring) is
**45 of 45 tasks merged and closed out**. M4 (Governance & Review Workspace) has
**no task breakdown yet** — writing and ratifying one is the first job.

Supersedes [HANDOFF-M3-RESUME-2.md](HANDOFF-M3-RESUME-2.md) and every earlier
handoff.

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

| Project | Files | Tests | Coverage |
|---|---|---|---|
| `apps/api` | 115 | **3199** | 91.44 % line / 97.46 % branch, every threshold met |
| `apps/studio` | 12 | **252** | 97.10 % line / 92.09 % branch |
| `packages/content-renderer` | 4 | **118** | — |
| `tools/seed` | 5 | **94** | — |

`pnpm -r typecheck` clean. Golden set **40 pass, 0 official papers, 4 synthetic**.
Working tree clean; nothing uncommitted, nothing in flight.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M3-CLOSEOUT.md](tasks/M3-CLOSEOUT.md) | **All of it.** The DoD verdict, the debt register, and the five real defects M3 found in itself |
| [tasks/M3-CONTENT-MODEL.md](tasks/M3-CONTENT-MODEL.md) | The **Decisions** section (DEC-1 … DEC-7) and the **scope boundary table** — that table is M4's brief |
| [ROADMAP.md](ROADMAP.md) § M4 | The five deliverables and the acceptance gate |
| [tasks/M3-TRACEABILITY.md](tasks/M3-TRACEABILITY.md) | The **Findings** table — nine partially-proven criteria, each mapped to a debt item |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §5 testing, §8 error handling, §9 architecture rules, §10 review checklist |
| [adr/ADR-0008](adr/ADR-0008-coverage-follows-correctness-bearing-code.md), [ADR-0009](adr/ADR-0009-authoring-dtos-carry-the-answer-key.md), [ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) | M3's three, all live constraints on M4 |
| [tasks/M3-PROGRESS.md](tasks/M3-PROGRESS.md) | Only when you need *why* something is shaped as it is. 45 rows |
| [FRS.md](FRS.md), [UX-ARCHITECTURE.md](UX-ARCHITECTURE.md) §10.2, [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | Per task only |

Internalise once. Do not re-read the full set per task.

---

## Where to start: **M4 has no task breakdown**

M1, M2 and M3 each began with an approved breakdown under `docs/tasks/`
(`M3-CONTENT-MODEL.md` is the model to follow: a scope boundary table, a
ratified Decisions section naming every question the approved documents do not
answer, a numbered task index with dependencies, per-task Files / Acceptance /
Tests, a sequencing block, and a Milestone Definition of Done).

**Write `docs/tasks/M4-GOVERNANCE-REVIEW.md` first, and get the opening
decisions ratified before implementing anything.**

Questions the approved document set does not appear to answer, which the
breakdown will have to raise:

1. **The ageing and escalation policy.** ROADMAP says "ageing escalation";
   [DECISIONS §C.6](DECISIONS.md) is the Reviewer Operating Model. Nothing states
   the thresholds, who an item escalates *to*, or whether escalation reassigns.
2. **Duplicate detection's algorithm and its blocking status.** M3 fixed
   `duplicateCheckState: 'deferred'` and the wording "has not run"; FR-QM-04
   rule 2 makes it advisory, never blocking. The three named techniques
   (normalized hash, trigram, placeholder-normalized numbers) need a decision
   about which is authoritative and what "same question, different constants"
   means precisely.
3. **Approve-with-edits records both versions** — is the reviewer's edit a new
   `ItemVersion` authored by the reviewer, or an amendment to the author's? This
   collides with **D25** below: a published item cannot currently be revised at
   all, and `approve_with_edits` is the first producer that would need it.
4. **The audit hash chain and its daily anchor** — where the chain lives
   (`platform.` or per-context), what is chained, and what "anchor" means
   operationally. F41 is named in ROADMAP testing and does not exist yet.
5. **The 40 items/hour gate.** ROADMAP's acceptance is a *timed session with 3
   real reviewers*. There is no running application (DEC-5, D3/M0), so this is
   the same shape of problem as M3's "≤ 20 min" criterion — decide up front
   whether it is reported as failed-blocked with a jsdom step count, or whether
   M4 pays for M0's bootstrap. **M3 declined to pay it twice; a third decline
   needs stating, not assuming.**
6. **`ItemDefect` intake and triage** — ROADMAP lists it under M4; M3's scope
   table also assigns `AnswerKeyChallenge` to M4. Neither is modeled yet.

---

## What M3 leaves M4, concretely

### The seam is already typed

`apps/api/src/contexts/content/m4-seam.spec.ts` imports **`content/public/` and
nothing else** and proves M4 can already:

- read `LIFECYCLE_STATES` and `LIFECYCLE_TRANSITIONS` (the queue is
  "everything `in_review`"; ageing escalates over the same list),
- read `REVIEW_OUTCOMES` — `approve`, `approve_with_edits`, `request_changes`,
  `reject` — and `ReviewedOwnerType`,
- construct every lifecycle command a workspace drives,
- type both view families, and render what a reviewer looks at,
- read the finding and precondition code sets the decision screen groups by.

A missing export is a compile failure in that file. **Extend the seam spec
before reaching past the barrel** — that instrument found a real gap at the
M2→M3 seam and again at M3→M4.

### The record a decision is written to already exists

`content.review_decision` and its repository were added at **M3-28**, because a
publication precondition that depends on another milestone's storage is not a
precondition. It is append-only in intent, polymorphic on owner
(`item_version`, `stimulus_version`, `solution_version`, `media_asset_version`),
and `findApprovalFor` returns the most recent *approving* decision, so
approved → returned → approved resolves to the approval that stands. Returned
work requires a justification, in the constructor **and** as a CHECK.

M4 owns the **workspace** that produces those decisions: assignment routing,
queue mechanics, ageing, the capture surface, the rejection taxonomy UI, and
duplicate detection. It does **not** own the state machine or any publication
precondition — [ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md)
records that divergence from ROADMAP M4's own wording, and it is ratified.

### Two ports are waiting for M4

`application/ports.ts` declares them and says so at the port:

- **`ReviewProgress`** — M4 supplies it. Until then **nothing claims a version**,
  so withdrawal while `in_review` is always permitted. That is stated in the
  spec, not hidden, and it is finding **W4** in the traceability document.
- **`RenderValidator`** — M3-38 supplies the function; there is no production
  adapter and no composition root (**D27**).

---

## Conventions that must continue

Everything in the M3 handoffs still holds. The ones that earned their place:

1. **A test must be able to fail.** Every scan asserts it scanned something;
   every parity check is shown to fail on a planted divergence first. M3's own
   gate register was green while naming the wrong spec files for F9 and F46 —
   caught at close-out, and only because the check was strengthened to assert
   the named spec contains its gate.
2. **Where an approved document cannot be honoured, say so in the spec** rather
   than narrowing the check until it passes. Three of M3-45's nine named
   rejection classes are not import rejections; they are carried as *accepted*
   records with the reasoning written down.
3. **Delivery views name their fields one at a time.** Never spread a domain
   object and delete what should not be there.
4. **An unreachable branch is deleted, not tested.**
5. **Ports over adapters.** In-memory doubles ship; each names its real owner.
6. **Domain returns typed Results; only infrastructure throws.** Every validation
   failure carries a location.
7. **Projections are recomputed on save, never accepted from a caller.**
8. **Decimal literals cross as text, everywhere.**
9. **Integration tests use real Postgres, never a mock.**
10. **A failing or skipped test blocks the task. No quarantine.** A flaky test is
    a broken test: M3-42 rewrote M1's wall-clock performance assertion into a
    scaling ratio rather than re-running it to green.

---

## Carried forward

### B1 — blocking gate, still open

**M2-30: the golden set is validated against zero real papers.** The CI gate runs
every commit and is **vacuous** — 4 synthetic fixtures, nothing about agreement
with an official key. Blocked on [DECISIONS §D item 2](DECISIONS.md) (content
licensing & IP policy), needing legal counsel sign-off.

The decision is one sentence: *may released papers with official NTA keys be held
in this repository as internal test fixtures, not served to learners?*
Acceptance: three papers under `apps/api/src/testing/golden/papers/` with
`provenance: "official"`, and the suite reporting `3 official`.

**Do not attempt to source papers.** Must appear in the M4 close-out and in every
handoff until it closes.

### Debt

| # | Item | Trigger |
|---|---|---|
| **D19** | Chemical **structure** diagram rendering (DEC-6) | The first `ChemBlock` degradation a chemistry SME reports as a defect rather than a choice |
| **D20** | ROADMAP M4 still lists the lifecycle machine as M4's; ADR-0010 records the divergence | Next doc revision — **M4 is that revision** |
| **D21** | `content_licensing.owner_type` excludes `solution_version` | If licensed third-party solutions are acquired |
| **D22** | The idempotency store is process-local | M0's durable store |
| **D23** | The authoring **subject is declared on the command**, not cross-checked against the content | When Curriculum exposes a concept→subject-domain lookup |
| **D24** | No publication precondition requires a **pinned stimulus to be published** | Next publication-rules revision |
| **D25** | A published item **cannot be revised at all**, so `supersedesItemVersionId` has no producer | **M4's `approve_with_edits` is the first thing that needs it** |
| **D26** | TECH-STACK names **Temml**; an in-repo converter stands in behind `latex-to-mathml.ts` | The first authored expression its subset cannot express |
| **D27** | **`RenderValidator` has no production adapter** | M0's composition root |
| **D28** | A repository constraint violation reaches the caller as `PERSISTENCE_REJECTED` carrying the **raw Postgres message** — SQL in a response (§8) | The next constraint a user can trip |
| **D7** | OpenAPI 3.1 meta-schema validation **not closed** — what ships is a strictly weaker structural check, named as such | When the meta-schema is obtainable |
| **D18** | **Closed for content.** Zod generated from the document, compared byte for byte | — |
| **D2, D3, D10** | Playwright E2E, the Studio app shell/router/build, browser-measured p95 | Explicitly deferred by DEC-5. **D10 has two instances now** |

D1, D4–D6, D8, D9, D11–D17 unchanged from M2.

---

## Environment

- **Postgres is required — no Docker** (ADR-0004). Homebrew, **port 5433**,
  superuser `postgres`, databases `questionbank` and `questionbank_test`.
- **`pnpm` is not on PATH — use `corepack pnpm`.**
- **There is no network.** `corepack pnpm install --offline` resolves from the
  store; nothing not already in `node_modules/.pnpm` can be added. Check the
  store before assuming a dependency is unavailable — M3-44 found
  `@vitest/coverage-v8@3.2.7` sitting there while Studio was pinned to a
  4.x that could not load.
- `apps/studio` and `packages/content-renderer` are separate vitest projects —
  run them from their own directories.
- `apps/api` has two vitest projects: `unit` and `integration`. Integration specs
  share one database and reshape its schema, so they run one file at a time:
  `corepack pnpm vitest run --project integration <path>`.

---

## What still does not exist

- **No running application.** No `main.ts`, no `main.tsx`, no Vite dev server, no
  Compose, no CI. Nothing calls any context outside tests. That is M0's, and M3
  declined twice to pay for it (DEC-5).
- **No review workspace.** That is M4.
- **No validated golden set.** See B1.
