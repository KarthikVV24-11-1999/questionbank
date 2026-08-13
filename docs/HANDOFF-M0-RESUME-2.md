# Handoff — M0 in progress, M0-01 through M0-11 merged, green at HEAD

**State as of 2026-08-13, HEAD `596113e`.** M0 (Walking Skeleton) is ratified. **11 of 27 tasks merged**,
Track A (ground) and half of Track B (the composition root) complete. M1, M2, M3 remain closed; M2's
`ScoreRecord` gained a required field this session (ADR-0017) — see below, it is a fix, not a reopening.

Supersedes [HANDOFF-M0-RESUME-1.md](HANDOFF-M0-RESUME-1.md).

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Both run clean. Full workspace, this session's final check:

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 135 | **3406** |
| `apps/studio` | 12 | **252** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 1 | **3** |
| `packages/domain-types` | 1 | **2** |
| `tools/seed` | 5 | **94** |

`pnpm -r typecheck` clean across all 6 typechecked projects. No coverage threshold violation anywhere in
the log. Working tree clean at HEAD.

---

## What landed this session (M0-08 → M0-11)

- **M0-08** — `PostgresIdempotencyStore`, **closes D22**. `remember()` is `INSERT ... ON CONFLICT DO
  NOTHING`; the primary-key constraint, not a read-then-write, is what resolves two genuinely concurrent
  inserts for one key to one row — proven by racing two connections. Durable-across-reconnection proven
  directly (a fresh instance against the same database sees what an earlier one remembered).
  `InMemoryIdempotencyStore` untouched; a shared contract spec runs both.

- **M0-09** — `RenderValidatorAdapter`, **closes D27**. Blocked mid-task on two real defects the first
  typecheck surfaced, both fixed as prerequisites: `MediaBlock.caption` had diverged (`string` on the
  renderer, `readonly Inline[]` on the domain — the domain won; `renderer-seam.spec.ts` now checks shape,
  not just kind names, via a type-level mutual-assignability check and a runtime field-by-field
  comparison, both proven against planted violations); and the task's own premise that no JSX transform
  was needed was false (`renderFor` calls a `.tsx` component — fixed with `"jsx": "react-jsx"` in
  `apps/api/tsconfig.json`, narrowed by `checkNoTsxFiles` asserting zero `.tsx` files under
  `apps/api/src/`, recorded in **ADR-0016**). The task entry itself was corrected in place. Publication
  now runs against the real renderer — an integration spec blocks publication on unrenderable LaTeX via
  FR-QM-14 rule 2, against real Postgres.

- **M0-10** — `FilesystemMediaStore` and `createMediaStore`. Content-addressed by sha256, sharded
  S3-prefix-style. `createMediaStore` throws `ProductionMediaStoreRefusedError` when `nodeEnv` is
  `production` rather than silently selecting local disk — the boot failure a hurried deploy cannot
  ignore. Path traversal rejected before any filesystem call, eight shapes proven.

- **M0-11** — The composition seam, **all three contexts**, closing with a real M2 defect fixed along the
  way:
  - Scoring's composition surfaced that `PostgresScoreRecordRepository` took `examProfileVersionId`/
    `taxonomyVersionId` at **construction**, correct for exactly one exam profile per instance — unworkable
    once handlers are composed as a single shared instance. Traced to the domain: `ScoreRecord` never
    carried either field, though the database columns were `NOT NULL` since M2's own migration. **Fixed**
    (`fix(scoring): a score record carries the pin that produced it`, **ADR-0017**): the pin now rides on
    the record; the repository reads and writes it like any other column. The old round-trip test
    (`expect(loaded).toEqual(record)`) was real but blind — neither side ever carried the fields — the same
    shape of gap as the caption seam. Strengthened to assert both fields by name; proven failing on the
    read side and the write side independently, then reverted. **`M2-TRACEABILITY.md` (finding F-7) and
    `M2-CLOSEOUT.md` are corrected in place**, not left to diverge.
  - **Content** (37 handlers), **curriculum** (22), **scoring** (8) each get `public/composition.ts` — a
    fourth barrel export, never re-exported through `index.ts` — proven to resolve every handler its own
    OpenAPI document names, via a real NestJS testing module. **ADR-0015** records the pattern.
  - A **correction found while starting M0-12**: `RenderValidatorAdapter` lives in
    `contexts/content/infrastructure/`, not under `platform/`. M0-11 had originally named it in
    `ContentCompositionDeps` for external injection — which would have forced `platform/composition/` to
    import it directly, a deep cross-context import and exactly what F1's `platform/` extension (M0-12)
    exists to refuse. Fixed before any such import was written: content's `register()` now constructs it
    internally (same-context import, always permitted).
  - `InMemoryReviewProgress`/`InMemoryEntitlements` wired as content's production choice (both
    deny-by-default, safe per finding W4 and INV-08). `InMemoryMigrationExecutor` stands in for
    curriculum's cross-context migration adapter, which no milestone through M0 builds.
    `PostgresEventPublisher` is a new, real adapter for scoring's event ports — one transaction per
    publish, its non-atomicity with the aggregate's own save transaction named in the file rather than
    hidden (the relay, D17, still unbuilt, will need to reconcile against it).
  - Every `register()` refuses at runtime on a missing dependency, proven against a deps object reached
    through a cast — the same posture F11 takes for a policy-less handler.

Every fitness function added is proven red on a planted violation. Every correctness-bearing module landed
at 100% coverage, added to the threshold list as it landed.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) | **The entries for M0-12 through M0-27** — you already know 01–11. The M0-09 entry has a correction block at its top; read that once for context on why its premise changed |
| [tasks/M0-PROGRESS.md](tasks/M0-PROGRESS.md) | One sentence per task, in order |
| [adr/ADR-0015](adr/ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md), [ADR-0016](adr/ADR-0016-the-api-type-checks-the-renderer-package.md), [ADR-0017](adr/ADR-0017-a-score-record-carries-its-own-pin.md) | All three merged this session |
| [tasks/M2-TRACEABILITY.md](tasks/M2-TRACEABILITY.md) finding F-7, [tasks/M2-CLOSEOUT.md](tasks/M2-CLOSEOUT.md) | The correction to M2's own record — read once, do not re-audit M2 |

---

## Where to resume: M0-12

**Next task is M0-12 — `createApplication`, the composition root.** `platform/composition/app-factory.ts`
composes all three contexts' `register()` (all now working and tested), the platform adapters from
M0-02–M0-10, the resolver (M0-06), and telemetry (M0-04). Concretely, it needs to:

- Build one `Pool` (M0-07's `createPool`), `SystemClock`, `UuidIdentifierFactory`, `PostgresAuditRecorder`,
  `PostgresIdempotencyStore` (M0-08), `createMediaStore(config)` (M0-10), `createPrincipalResolver` (M0-06),
  and a `Telemetry` (`createJsonTelemetry` in production, `RecordingTelemetry` for tests, M0-04).
- Call `content.register`, `curriculum.register`, `scoring.register` with each context's own narrow deps —
  **content's no longer takes `renderer`** (see the correction above; only `pool`, `mediaStore`,
  `idempotency`, `clock`, `identifiers`, `audit`, `principals`).
- Combine the three `DynamicModule`s into one root module and build a real `INestApplication` (likely a
  small `RootModule.register(imports)` following the same static-register convention every `*.module.ts`
  in this repo already uses — there is no existing "combine N modules" helper to copy).
- **Extend F1 to `platform/`**: `platform/composition/` may import `contexts/*/public/**` and nothing
  deeper. `boundary-rules.ts`'s scanner currently only walks `src/contexts/**`; it needs a second
  invocation (or an extended `include`) covering `src/platform/**`, proven against a planted deep import of
  `contexts/content/infrastructure/item.repository.js` from the composition root.
  Confirmed clean going in: nothing under `platform/` imports a context's `application/`, `domain/` or
  `infrastructure/` directly today — the M0-11 correction was found and fixed specifically to keep this
  true, so the new scan should pass on the real tree the first time.
- **F11 at the application level**: a planted policy-less handler across the *composed* set (not one
  context in isolation) must make `createApplication` reject.
- `overrides` parameter exists for tests only — a unit spec asserts the production path passes none.

The task entry (`M0-WALKING-SKELETON.md`) is accurate as written; no correction needed there before
starting, unlike M0-09.

**After M0-12:** M0-13 (`main.ts`, health, readiness, graceful shutdown) and M0-14 (the walking skeleton
itself — one authenticated request end to end) are what M0-12 exists to make possible. Track C (Studio),
Track D (authored infra: Compose/CI/Terraform), and Track E (gates) have not started.

---

## Conventions this session reinforced

1. **A test must be able to fail.** Every fitness check and every domain fix this session is shown red on
   a planted violation before being trusted. The `renderer-seam.spec.ts` mutual-assignability function
   (never called, but type-checked) and the `score-record.repository.ts` read/write proof-of-instrument
   cycle (revert → break → red → restore) are the two techniques worth copying verbatim for M0-12's F1
   extension proof.
2. **A real gap found mid-task gets fixed and recorded, not routed around.** Three separate instances this
   session: the caption divergence, the JSX premise, and the `ScoreRecord` pin. Each got its own commit,
   its own ADR where the decision was non-trivial, and a correction to whatever document had been wrong —
   `M0-WALKING-SKELETON.md`'s M0-09 entry, `M2-TRACEABILITY.md`, `M2-CLOSEOUT.md`. None were silently
   patched.
3. **A structural superset type crossing a boundary is proven, not assumed.** `AuditRecordLike` (M0-07),
   the `bag` objects in every `composition.ts`, and `PostgresScoreRecordRepository`'s port conformance all
   rely on TypeScript structural assignability rather than `implements` against every consumer's
   interface. Where this was previously unproven (D27's JSX chain, the caption shape), it broke loudly at
   `tsc --noEmit` — which is the point, and why typecheck runs after every file, not just at session's end.
4. **Ports keep their in-memory doubles.** Nothing from M0-01 through M0-07 was touched. `InMemoryReviewProgress`
   and `InMemoryEntitlements` are wired as content's actual production choice this session, not replaced.
5. **A failing or skipped test blocks the task. No quarantine.** Held without exception.

---

## Environment

Unchanged from [HANDOFF-M0-RESUME-1.md](HANDOFF-M0-RESUME-1.md). Postgres on 5433, `corepack pnpm`, no
network, integration specs one file at a time. This session additionally confirmed: `corepack pnpm install
--offline` resolved `react`/`react-dom`/`@types/react` for `apps/api` cleanly (M0-09), and the DB migration
that added `platform.idempotency_key` (M0-08) coexists with every prior migration with no conflict.

---

## What still does not exist

- **No running application.** `main.ts` does not exist yet (M0-13). M0-12 is the last thing standing
  between the current state — three fully composable contexts — and a process that boots.
- **No review workspace.** Still M4, untouched.
- **No validated golden set.** B1 still open. Golden set this session: **40 pass, 0 official papers, 4
  synthetic** — unchanged; the `ScoreRecord` pin fix touches the executor's output shape but not any rule
  it computes.

---

## Carried forward

### B1 — blocking gate, still open

Unchanged. **Do not attempt to source papers.**

### Debt

**Closed this session:** D22 (M0-08), D27 (M0-09). **D3 and D9 remain open** (M0-15, M0-24 respectively —
neither started).

**New this session:** none beyond what M0-09/M0-10's own tasks already named (D31, D32) and the
`PostgresEventPublisher` limitation documented in `contexts/scoring/public/composition.ts`'s header (not
atomic with the aggregate's save transaction — the relay, D17, will need to reconcile).

D19–D21, D23–D26, D28 carried unchanged from HANDOFF-M4.md.
