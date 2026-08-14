# Handoff — M0 closed, M4 next

**State as of 2026-08-14.** M0 (Walking Skeleton) is **closed — all 27 tasks merged.** M1, M2 and M3 were
already closed. **M4 (Governance & Review Workspace) has no task breakdown yet** — writing and ratifying one
is the first job, exactly as the previous version of this document said before M0 existed to change what it
could say.

This document is rewritten from scratch, not amended — the version it replaces predates M0 and was wrong in
most of its detail the moment M0 landed a running application.

Supersedes every earlier handoff.

---

## The app runs. Say that plainly, because it wasn't true before.

`corepack pnpm --filter @questionbank/api start` boots the fully composed application — content, curriculum
and scoring, every platform adapter, real Postgres — and serves a real request. Verified live, not assumed:
`/healthz` 200, `/readyz` 200 against real Postgres, an authenticated `GET /v1/exams` returns `200 []` with
`X-Correlation-Id` present on the response and on every span in the tree that request emitted. Studio builds
or navigates and one of its surfaces (the Item Browser) talks to that same running application through a
typed client, end to end, against a seeded draft.

None of that was true when M3 closed. It is the one fact this handoff most needs M4 to actually read, not
skim past.

---

## What M0 closed

- **D3** — Studio has an entry point, a real Vite build, real navigation over the History API, and one
  live surface.
- **D9** — the `questionbank_app` database role exists locally; F7/F40 fires against a real role for the
  first time.
- **D22** — the idempotency store is durable and survives a restart.
- **D27** — `RenderValidator` has a production adapter; the publication precondition runs against it.

## What M0 could not close, and why

- **F8** (`docker compose up ≤ 10 min`) — `Fail — blocked`, no container runtime on this machine. The
  Compose file itself is authored and its service graph, health checks and dependency order are asserted by
  parsing it (Tier 2, ADR-0013) — none of that is a boot time.
- **The Grafana trace** — `Fail — blocked` on two independent resources: no `@opentelemetry/*` package in
  the offline dependency store (**D31**), and no Grafana account. The in-process span tree
  (`RecordingTelemetry`, proven in `walking-skeleton.integration.spec.ts`) is real, but it is not a trace in
  a backend and is never described as one.
- **The staging deploy** — `Fail — blocked`, no cloud account, no network, no CI runner. Terraform is
  authored and lint-scanned (never validated, never applied — the lint says so in its own header).
- **CI actually running** — `Fail — blocked`, no CI provider connected. `.github/workflows/ci.yml` exists,
  is a thin caller with zero assertions of its own (DEC-M0-3), and has never been executed.

Full detail, every criterion mapped to its proof and its tier: [tasks/M0-TRACEABILITY.md](tasks/M0-TRACEABILITY.md).
The Definition of Done verdict, the debt register, and B1's restatement: [tasks/M0-CLOSEOUT.md](tasks/M0-CLOSEOUT.md).

---

## M3's "≤ 20 min" gate — is it measurable now?

**Not yet — and the reason changed shape, which is the whole point of M0 landing.** Before M0, this gate was
`Fail — blocked on D3/M0`: there was no application to author a stimulus-linked set *in*. Now there is one,
and the blocker is exactly one thing: **D29, the Item Editor's commands are not wired to the live API.**
Studio's Item Browser is the one surface M0 wired end to end (M0-19); the editor that would let an author
actually *do* the 20-minute task still runs on its in-memory model.

So the honest statement is: **the blocker shrank from a milestone to a task.** Wiring the Item Editor the
same way M0-19 wired the Item Browser — the typed client already exists, the composed API already runs — is
what would make this gate measurable for real, and it is not part of M4's own scope unless M4 chooses to pay
for it. If M4 needs this gate closed, that is a decision to make explicitly, not an assumption to inherit.

---

## M4's own timing gate has the same shape — decide how to report it now, not at close-out

ROADMAP's M4 acceptance is **"40 items/hour reviewing, timed with 3 real reviewers."** There is no review
workspace yet — M4 builds it — so this gate is `Fail — blocked` today for the same reason "≤ 20 min" was
before M0: the surface the timing would run against does not exist.

**M0 does not change this, and M0's own close-out says so explicitly** (DEC-M0-12's table, restated in
`M0-CLOSEOUT.md`): *"the blocker moves from M0 to M4's own scope. M4 must not read M0's landing as permission
to claim it."* Read literally: **the fact that a real application now runs is not evidence that a review
workspace timed with real reviewers exists.** Those are different facts, and the second one is M4's alone to
produce.

**What M4 should decide up front, before writing its own task breakdown**, is exactly how this gate gets
reported at each milestone checkpoint — `Fail — blocked` with a named successor from day one, the way M0
reported F8 and the Grafana trace, rather than a status that quietly drifts toward "basically met" as
individual pieces land. Deciding the reporting posture *before* the pressure of a close-out is what kept
M0's own close-out honest; there is no reason M4 should have to relearn that under time pressure.

---

## M4 has no task breakdown yet

`docs/tasks/M4-GOVERNANCE-REVIEW.md` does not exist. **Writing and ratifying one is the first job** —
`M3-CONTENT-MODEL.md` and `M0-WALKING-SKELETON.md` are both the model to follow: a scope boundary table, a
ratified Decisions section naming every question the approved documents do not answer, a numbered task
index with dependencies, per-task Files / Acceptance / Tests, a sequencing block, and a Milestone Definition
of Done with tiers named the way ADR-0013 now generalizes them.

Questions the approved document set does not appear to answer, carried forward from the previous version of
this handoff (still unanswered — M0 did not touch M4's own domain):

1. **The ageing and escalation policy.** ROADMAP says "ageing escalation"; DECISIONS §C.6 is the Reviewer
   Operating Model. Nothing states the thresholds, who an item escalates *to*, or whether escalation
   reassigns.
2. **Duplicate detection's algorithm and its blocking status.** M3 fixed `duplicateCheckState: 'deferred'`;
   FR-QM-04 rule 2 makes it advisory, never blocking. The three named techniques need a decision about which
   is authoritative.
3. **Approve-with-edits records both versions** — is the reviewer's edit a new `ItemVersion` authored by the
   reviewer, or an amendment to the author's? Collides with **D25**: a published item cannot currently be
   revised at all, and `approve_with_edits` is the first producer that would need it.
4. **The audit hash chain and its daily anchor** — where the chain lives, what is chained, what "anchor"
   means operationally. F41 is named in ROADMAP testing and does not exist yet.
5. **The 40 items/hour gate's reporting posture** — see above. Decide now, not at close-out.
6. **`ItemDefect` intake and triage** — ROADMAP lists it under M4; M3's scope table also assigns
   `AnswerKeyChallenge` to M4. Neither is modeled yet.

---

## What M4 inherits from M0, concretely

- **A running application it can build against directly.** `createApplication` (M0-12) composes all three
  contexts already; a review workspace is a fourth context's handlers, wired the same way M0-19 wired
  Studio's Item Browser — through content's own `public/composition.ts` seam (ADR-0015), not a new pattern.
- **A typed client.** `packages/contracts/src/client.ts` (M0-17) is not content-specific; M4's own review
  surface uses the same `createClient`, validated against whatever Zod schemas M4's own OpenAPI document
  generates.
- **Two ports still waiting**, exactly as the pre-M0 handoff named them:
  - **`ReviewProgress`** — M4 supplies it. Until then nothing claims a version, so withdrawal while
    `in_review` is always permitted (finding W4, unchanged).
  - Everything else M3 already handed M4 (the lifecycle state machine, the `review_decision` table, the
    m4-seam spec) is unchanged by M0 and still holds.
- **The tiering discipline itself.** ADR-0013 is not M0-specific — the next milestone that authors something
  it cannot run (a queue consumer with no message broker locally, say) cites it rather than re-deriving the
  same three-tier argument.

---

## Conventions M0 reinforced, worth M4 continuing

1. **A real defect found while proving a task honest gets fixed and recorded, not routed around.** Five
   separate instances across M0 (the `ListMyDrafts` wrapping bug, the client's `JSON.parse` crash,
   `CreateItemDraftHandler`'s view bypass, the pool-leak-on-shutdown bug, `main.ts`'s entry guard never
   firing) — each with its own commit and, where the decision was non-trivial, its own debt item or ADR.
2. **A test asserting a fact that stopped being true is rewritten, never deleted.** `content-rules.integration.spec.ts`'s
   "the role is absent" test became "the role exists, with exactly this privilege set" — same discipline
   `StudioShell.spec.tsx`'s DEC-5 entry-point test followed a session earlier.
3. **A port narrower than its interface is named in the adapter's own header, not discovered by a future
   reader.** D33 is the latest instance of the pattern W4 and INV-08 already set.
4. **A Tier-2 artifact never claims a Tier-1 property, and every Tier-2 task names its Tier-3 successor
   command verbatim.** ADR-0013 is where this is now written down permanently.
5. **A failing or skipped test blocks the task. No quarantine.** Held without exception across all 27 tasks.

---

## Environment

Unchanged: Postgres on 5433 (Homebrew, ADR-0004), `corepack pnpm`, no network,
`corepack pnpm install --offline`. **New**: `corepack pnpm --filter @questionbank/api start` boots the real
server via `vite-node` (no build step exists for `apps/api`); `apps/studio` builds via
`corepack pnpm --filter @questionbank/studio build`.

---

## Carried forward

### B1 — blocking gate, still open

**M2-30: the golden set is validated against zero real papers.** Blocked on
[DECISIONS §D item 2](DECISIONS.md) (content licensing & IP policy), needing legal counsel sign-off. The
decision is one sentence: *may released papers with official NTA keys be held in this repository as internal
test fixtures, not served to learners?* **Do not attempt to source papers.** Must appear in M4's own
close-out and in every handoff until it closes.

### Debt

D3, D9, D22, D27 — **closed this milestone.** New: D29 (Item Editor unwired), D30 (navigation is not a
router), D31 (no OTLP exporter), D32 (no S3 `MediaStore` adapter), D33 (Item Browser's subject/concept
filters have no source), D34 (`CreateItemDraftHandler` echoes the raw aggregate). Unchanged: D19–D21,
D23–D26, D28.
