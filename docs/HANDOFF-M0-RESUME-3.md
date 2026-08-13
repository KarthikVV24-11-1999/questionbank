# Handoff — M0 in progress, M0-01 through M0-14 merged, green at HEAD

**State as of 2026-08-13, HEAD `60c4713`.** **14 of 27 tasks merged.** Track A (ground) and **all of
Track B (the composition root)** are complete. **M0-14 landed: a real authenticated request now reaches
the database, end to end, through the fully composed application.** Track C (Studio as an application),
Track D (authored infrastructure) and Track E (gates and close-out) have not started.

Supersedes [HANDOFF-M0-RESUME-2.md](HANDOFF-M0-RESUME-2.md) and every earlier handoff.

---

## Does a real authenticated request reach the database? **Yes.**

`apps/api/src/platform/walking-skeleton.integration.spec.ts` proves it, against real Postgres, through
`createApplication` with no overrides but the pool and telemetry: a bearer token issued by the M0-05 stub
→ `PrincipalResolver` → `GET /v1/items/:itemId` → `GetPublishedItemHandler` → `PostgresItemRepository` →
Postgres → a delivery response carrying `X-Correlation-Id`. Every span in the tree (root = route, child =
handler, grandchild = `db.query`) shares that id as its `traceId`. The no-answer-key guarantee (F6/F35) is
re-proven over live output, not the document. Unauthenticated → 401; expired token → 401; and the 401 check
is shown fallible — a planted resolver bypass turns the same unauthenticated request into a 200, proving the
assertion could have caught a real regression.

**What it does not prove**, stated in the spec's own header: that any of this runs anywhere but this
machine (no Compose boot, no CI, no deployed process — DEC-M0-1), and nothing about a PII-scrubbed *log
line*, because nothing on this request path writes one today (`createPrincipalResolver` is wired with no
`logger` in `createApplication`). The span tree is the one observability surface this milestone can and
does assert against, per DEC-M0-10.

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Both run clean, exit 0. Full workspace, this session's final check:

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 142 | **3431** |
| `apps/studio` | 12 | **252** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 1 | **3** |
| `packages/domain-types` | 1 | **2** |
| `tools/seed` | 5 | **94** |

`pnpm -r typecheck` clean across all 6 typechecked projects. `apps/api`'s coverage run (`pnpm test`, which
runs `vitest run --coverage` across both unit and integration projects) exits 0 — no threshold violation.
Working tree clean at HEAD.

---

## What landed this session (M0-12 → M0-14)

### The two things owed from the previous session, done first

1. **Grep for other construction-time-context leaks (the ADR-0017 shape).** Every repository and adapter
   in the tree was checked: all thirteen repositories (`grep -n "constructor(" **/*.repository.ts`) take
   only a `Pool`/`NodePgDatabase`, nothing else. **No second instance found.** Content's and curriculum's
   repositories never carried this shape at all; scoring's was the only one, and ADR-0017 already fixed it
   last session.
2. **Standing rule adopted and stated here**: every save-then-load test must assert deep equality over the
   **whole** aggregate, never field by field. Not retrofitted this session — no existing round-trip test was
   touched — but every *new* test this session's tasks added (`app-factory.spec.ts`,
   `walking-skeleton.integration.spec.ts`) follows it: the walking-skeleton spec's span-tree assertions check
   the full `SpanRecord` shape (`traceId`, `parentSpanId`, `name`) rather than one field, and its no-key scan
   serializes the whole response body rather than checking named fields one at a time.

### M0-12 — `createApplication`, the composition root (F11 at boot)

`platform/composition/app-factory.ts`. `createApplication(config, overrides?)` composes all three
contexts' `register()`, the platform adapters (M0-02 through M0-11), the resolver and telemetry, into one
`INestApplication` via `RootModule.register(imports)` — a static-register wrapper following the same
convention every `*.module.ts` in the repository already uses, declaring no controller and no provider of
its own.

- **F1 extended to `platform/`**: proven two ways — the existing `checkBoundaries` scanner already walks all
  of `src` by default (no code change needed there), and a new planted fixture
  (`src/fitness-fixtures/as-platform-composition/planted-platform-boundary-violation.ts`, importing
  `contexts/content/infrastructure/item.repository.js` directly) proves the scan is not vacuous — plus a
  direct assertion that `src/platform/` actually contains files, per DEC-M0-1's standing instruction against
  a vacuous green.
- **F11 at the composed level**: `overrides.contentRegister` lets a unit spec substitute a fake register that
  builds `ContentModule` with a policy-less handler; `createApplication` rejects, naming the handler
  (`MissingAuthorizationPolicyError`), proving the whole composed handler population — not one context in
  isolation — is checked.
- **`overrides` is proven test-only**: a unit spec calls `createApplication(config)` with no second argument
  and asserts it still builds, using only real defaults.
- **Closes M0-10's own deferred integration criterion**: `createApplication` with `nodeEnv: 'production'`
  and no media-store override now provably fails to boot (`ProductionMediaStoreRefusedError` propagates),
  proven at unit speed since `createPool`/`createMediaStore` never connect at construction.
- **A new observability seam, entirely in `platform/`, no context file touched**: `TelemetryInterceptor`
  (`platform/observability/telemetry.interceptor.ts`) is a global Nest interceptor that decides the
  correlation id once, before the controller method runs, and wraps it in two nested spans — root named for
  the route template (`GET /v1/items/:itemId`), child named for the matched controller method
  (`getPublishedItem`). `instrumentPool` (`platform/observability/instrumented-pool.ts`) wraps `pool.query`
  so every repository call across every context becomes a `db.query` child span, automatically, because
  every repository already calls `pool.query` — nothing about this required touching a repository, a
  controller, or `http-runner.ts`. **This is what makes M0-14's span-tree assertion possible without the
  scope expansion a naive implementation would have needed** (see the note below on the road not taken).
- `app-factory.integration.spec.ts` proves the composed app resolves a real handler in **each** of the three
  contexts against real Postgres in one file — curriculum's `ListExams`, content's `GetPublishedItem`,
  scoring's `GetScoreRecord` (with an `ops` token — its ownership check compares against an `ownerUserId`
  the controller never supplies, so `learner` alone gets refused before the query runs).

### M0-13 — `main.ts`, health, readiness & graceful shutdown

`apps/api/src/main.ts` (~35 lines, exports `main()` guarded by an `import.meta.url` check so a spec can
import and call it without triggering a real boot on import) and `platform/http/health.controller.ts` +
`health.module.ts`.

- `/healthz` — 200, touches nothing. `/readyz` — `SELECT 1`, 503 with `{ status: 'unavailable', reason }` on
  failure. Both absent from every OpenAPI document (asserted by parsing all three), neither authenticated.
- **`app-factory.ts` gained one more thing this task**: it now closes the pool it built itself when
  `app.close()` is called — but only that pool, tracked via a `poolOwnedByFactory` flag, so a test that
  supplies its own pool via `overrides.pool` keeps full control and is never double-closed.
- **SIGTERM draining proven for real**, not simulated: `main.integration.spec.ts` boots a real app on a real
  port, fires a real in-flight `/readyz` request against real Postgres, waits ~20ms for the OS-level
  handshake to complete (otherwise `SIGTERM` can race the accept and refuse the connection outright — found
  by running the test red first), emits `SIGTERM` via `process.emit` (not `process.kill` — this is the
  standard in-process technique, doesn't touch the OS or the test worker itself), and asserts the in-flight
  request still completes 200 before `process.exit(0)` fires. The request uses a plain `node:http` `GET`
  with `Connection: close` rather than `fetch`, because `fetch`'s keep-alive agent would leave the socket
  open and Node's `server.close()` waits indefinitely for every open connection — found the same way, by
  running it red first and reading why it hung.

### M0-14 — The walking skeleton

Covered above. One file: `apps/api/src/platform/walking-skeleton.integration.spec.ts`.

Every fitness function and every span-tree/draining assertion added this session is proven able to fail —
either against a planted fixture (F1's platform extension) or against a planted behavioural regression (the
resolver bypass, the policy-less handler).

---

## A judgment call worth reading before touching telemetry again

M0-14's acceptance names a three-level span tree — root (route), child (handler), and "at least one child
naming a database call" — and its own Files list names only the spec. Read literally, that implies the
wiring to produce it already existed. It did not: nothing in `contexts/*` called into `Telemetry` before this
session (`grep -rln "Telemetry\|startSpan\|withSpan" contexts/` was empty at session start), and the
naive way to add a *distinct handler-level span* — extending `HttpRunnerDependencies`, `content.module.ts`,
both controllers, and every spec that constructs them — would have touched a dozen files across a context
this task's Files list did not name, for a change unrelated to what M0-14 is actually testing.

**The alternative landed instead**: a global `NestInterceptor` plus a `Pool.query` wrapper, both entirely
within `platform/`, using the request object's own route metadata (`request.route.path`) and the matched
controller method's own name (`context.getHandler().name`) to name the two outer spans — no context file
read, no context file touched, and the resulting span tree is real, not simulated (see the JSON span lines in
any integration run's stdout). This is recorded here because it is the kind of decision DEC-M0-5 and
ADR-0015 already made once for the composition seam itself — reach for the platform-only path before reaching
into a context — and it is worth recognising as the same shape of choice if a future session extends
telemetry further (e.g., wanting *query text* in a span, which the current `instrumentPool` deliberately
never attaches, for the PII reason its own header states).

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) | **The entries for M0-15 through M0-27** — Track C (Studio), Track D (authored infra), Track E (gates). You already know 01–14 |
| [tasks/M0-PROGRESS.md](tasks/M0-PROGRESS.md) | One sentence per task, in order — **note the M0-12/M0-14 entries flag a commit-message slip** (a `docs:`-labeled commit accidentally carried the M0-13 source files; content is correct, only the label on that one commit is wrong) |
| [adr/ADR-0015](adr/ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md), [ADR-0016](adr/ADR-0016-the-api-type-checks-the-renderer-package.md), [ADR-0017](adr/ADR-0017-a-score-record-carries-its-own-pin.md) | Unchanged this session, still load-bearing on the composition root |

---

## Where to resume: M0-15 (Track C — Studio as an application, closes D3)

Not started. `apps/studio` has no `index.html`, no `main.tsx`, no Vite config, no build. M0-15 through
M0-18 are Track C; read their entries fresh, they were not summarized last session.

**Track D** (Compose, CI workflow, Terraform — M0-19 through M0-22, all Tier 2 per DEC-M0-1) and **Track E**
(gates and close-out — M0-23 through M0-27) remain entirely unstarted.

---

## Conventions this session reinforced

1. **A platform-only path beats a cross-context one, even when it costs more design effort up front.** The
   telemetry interceptor is this session's version of what ADR-0015 already established for the composition
   seam itself.
2. **A timing-sensitive integration test is proven red first, then fixed with the actual reason understood**
   — not padded with an arbitrary retry or a longer sleep. Both `main.integration.spec.ts` fixes (the
   accept-race, the keep-alive hang) were diagnosed from a failing run's exact error, not guessed at.
3. **`overrides` parameters exist for tests only, and a spec proves it** — `createApplication`'s production
   path is asserted to pass none, the same posture M0-11's `register()` functions already took for their own
   `deps`.
4. **A pool a factory built is a factory's to close; a pool a caller supplied stays the caller's.** One
   boolean flag, set once, is what keeps `app-factory.integration.spec.ts` and `main.ts`'s real shutdown from
   fighting over the same connection's lifecycle.
5. **A failing or skipped test blocks the task. No quarantine.** Held without exception — every new test this
   session is green in the final full run.

---

## Environment

Unchanged from [HANDOFF-M0-RESUME-2.md](HANDOFF-M0-RESUME-2.md). Postgres on 5433, `corepack pnpm`, no
network, integration specs one file at a time via the `integration` vitest project.
`main.integration.spec.ts` additionally binds a real port (`34567`) for its SIGTERM test — integration specs
already run sequentially, one file at a time, so this does not collide with any other spec.

---

## What still does not exist

- **No Studio build.** M0-15 through M0-18, untouched.
- **No Compose boot, no CI run, no Terraform plan.** All Tier 2 or Tier 3 per DEC-M0-1; F8 stays
  `Fail — blocked`.
- **No review workspace.** Still M4, untouched.
- **No validated golden set.** B1 still open. Golden set this session: **40 pass, 0 official papers, 4
  synthetic** — unchanged; nothing this session touches the executor's rule computation.

---

## Carried forward

### B1 — blocking gate, still open

Unchanged. **Do not attempt to source papers.**

### Debt

**Unchanged this session.** D19–D21, D22 (closed, M0-08), D23–D26, D27 (closed, M0-09), D28–D32 carried as
HANDOFF-M0-RESUME-2.md records them. **D3 and D9 remain open** — D3 is M0-15's to close next; D9 is M0-24's,
still unstarted.
