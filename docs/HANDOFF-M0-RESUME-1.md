# Handoff — M0 in progress, M0-01 through M0-07 merged

**State as of 2026-08-13, HEAD `8f16411`.** M0 (Walking Skeleton) is ratified
([docs/tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md), 27 tasks,
14 decisions all accepted as proposed). **7 of 27 tasks merged.** M1, M2, M3
remain closed and unaffected.

Supersedes [HANDOFF-M4.md](HANDOFF-M4.md) for M0 work in progress; M4's own
handoff still governs once M0 closes.

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Both run clean. Full workspace: **7 projects, all passing**, no coverage
threshold violation anywhere.

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 127 | **3323** |
| `apps/studio` | 12 | **252** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 1 (new) | **3** |
| `packages/domain-types` | 1 (new) | **2** |
| `tools/seed` | 5 | **94** |

`pnpm -r typecheck` clean across all 6 typechecked projects. Working tree
clean at HEAD; nothing uncommitted.

---

## What landed (M0-01 → M0-07)

All under `apps/api/src/platform/`, per the ratified layout
([M0-WALKING-SKELETON.md, DEC-M0-5](tasks/M0-WALKING-SKELETON.md#dec-m0-5--the-composition-root-lives-in-platform-and-reaches-contexts-through-a-fourth-barrel-export-adr-0015)).

- **M0-01** — `apps/api/src/fitness/workspace-rules.ts`. Asserts
  `pnpm-workspace.yaml`'s globs cover every on-disk package and every
  package declares `test`+`typecheck`. Running it found `packages/contracts`
  and `packages/domain-types` had neither — fixed with real `tsconfig.json`,
  `vitest.config.ts` and a smoke spec each, not a `passWithNoTests` stub.
  **ADR-0011** records deferring Turborepo (not in the offline store; its
  value is realised in CI, which does not exist here), trigger: `pnpm -r
  test` over 10 min in CI, or a sixth workspace project.
- **M0-02** — `platform/config/config.ts`. `loadConfig(env)` is total, never
  throws, validates all eight keys individually. `authSigningKey` has no
  default anywhere — every other key does, and none of the defaults are
  unsafe. `loadConfigFromProcessEnv()` is the **one** call site in the
  application that reads `process.env`; F16's enumerated allowlist
  (`config.ts`, `testing/database.ts`) is proven against a planted reader in
  `fitness-fixtures/as-platform-env-reader/`.
- **M0-03** — `platform/observability/{serializer,logger}.ts`.
  `filterAllowlisted` keeps only enumerated keys at every depth — an
  allowlisted key's object or array value is walked by the same rule, so an
  entity spread under a permitted key is still caught. `createLogger` emits
  one JSON line per event, gates `debug` off in production regardless of
  configured level, and logs an error's message/code always but its stack
  only outside production. Proven against a nested-PII fixture (route
  survives; email/phone/fullName are dropped and named, never their values).
- **M0-04** — `platform/observability/{telemetry,recording-telemetry}.ts`.
  `createTelemetry` is the shared span-tracking core behind
  `createJsonTelemetry` (production) and `createRecordingTelemetry` (the
  double); parent linkage tracked via `AsyncLocalStorage`, surviving an
  `await` between nested `withSpan` calls. A span cannot start without a
  `correlationId` — it becomes the trace id, never duplicated into the
  attribute bag. Span attributes pass through the same allowlist a log
  record does. **No OTLP exporter is written** (not in the offline store;
  debt **D31**); a spec asserts no `@opentelemetry` import exists anywhere
  in the project.
- **M0-05** — `platform/auth/token.ts`, **ADR-0014**. `issue`/`verify`: a
  three-segment HMAC-SHA256 bearer token over `node:crypto` alone. The
  header is fixed and ignored on verify — there is no algorithm to confuse,
  by construction. Length-checked before every `timingSafeEqual` so a
  malformed signature refuses rather than throws. `verify` returns exactly a
  `PrincipalRef`; `ai_agent` verifies exactly like `human` (D10); a spec
  asserts the module never mentions publication (INV-01 stays enforced once,
  in content's own precondition). ADR-0014 states plainly what the stub is
  not — no user store, password, refresh, revocation, or role assignment,
  all M8's — with M8's start as the replacement trigger.
- **M0-06** — `platform/auth/principal-resolver.ts`. The **one**
  `PrincipalResolver` adapter satisfying content's, curriculum's and
  scoring's independently-declared interfaces — no per-context branch,
  asserted by scanning the stripped source for any context name. Every
  refusal returns `null` identically and logs an identically-shaped `warn`
  record; only `errorCode` varies, so an operator can distinguish causes
  without the outward behaviour ever differing. The raw token is proven
  absent from every log entry, valid or tampered.
- **M0-07** — `platform/persistence/{clock,identifiers,pool,audit-recorder}.ts`
  + migration `infra/migrations/20260813120000_platform_audit.sql`.
  `SystemClock`/`UuidIdentifierFactory` are the one production
  implementation each of the `Clock`/`IdentifierFactory` ports content,
  curriculum and scoring each declare independently. `PostgresAuditRecorder`
  writes to the new `platform.audit_record` — one physical table serving all
  three contexts' audit shapes via a structural superset type, never
  importing a context's application layer. Append-only by trigger
  (mirrors `scoring_immutability.sql`'s pattern); proven against real
  Postgres with a rejected UPDATE and DELETE, and round-tripped for all
  three contexts' record shapes (curriculum's `targetVersion`, content's
  `justification`).

**Every fitness function added is proven red on a planted violation**,
committed under `apps/api/src/fitness-fixtures/`. Every correctness-bearing
module landed at 100% coverage, added to `apps/api/vitest.config.ts`'s
threshold list as it landed, not after.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) | **The entries for M0-08 through M0-27** — you already know 01–07. Re-read the Decisions section (DEC-M0-1 through DEC-M0-14) only if a task's acceptance references one you don't recall |
| [tasks/M0-PROGRESS.md](tasks/M0-PROGRESS.md) | One sentence per task, in order. Faster than re-reading seven commits |
| [adr/ADR-0011](adr/ADR-0011-pnpm-workspace-stands-in-for-turborepo.md), [ADR-0014](adr/ADR-0014-the-auth-stub-issues-a-principal-not-an-identity.md) | The two ADRs this session wrote, both already merged |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) §1, §9 | Folder structure and the twenty architecture rules — unchanged, but M0-08 onward starts composing across them |

Internalise once. Do not re-read the wider document set per task.

---

## Where to resume: M0-08

**Next task is M0-08 — durable `IdempotencyStore`, closing D22.**
Implements the existing `IdempotencyStore` port from
`contexts/content/application/ports.ts` **unchanged** against Postgres,
keyed with a unique constraint so concurrent duplicate requests resolve to
one execution (proven with two overlapping transactions, not a
read-then-write). `InMemoryIdempotencyStore` stays as the double.

After M0-08, the remaining sequence in Track B (composition root) is
**M0-09** (`RenderValidator` production adapter, closing **D27**), **M0-10**
(`MediaStore` filesystem adapter, refusing to boot in production — new debt
**D32**), **M0-11** (the composition seam on every barrel, **ADR-0015**),
**M0-12** (`createApplication`), **M0-13** (`main.ts`), **M0-14** (the
walking skeleton itself — one authenticated request end to end). Track A
(ground) is fully closed; Track C (Studio), D (authored infra), E (gates)
have not started.

**Follow the same per-task loop the M0-01→07 commits establish**: read the
task entry only, touch only the files it names (deviating and saying so in
one line when a task's own acceptance criterion demands more — M0-01's
package-script gap and M0-02's config-reading wrapper are the two precedents
this session set), write a test for every acceptance criterion, run only the
project touched, commit as `chore(platform): <imperative subject>`, append
one sentence to `M0-PROGRESS.md`, move on without asking.

---

## Conventions that must continue

Everything in the M3 handoffs still holds; the ones M0-01→07 exercised
directly:

1. **A test must be able to fail.** Every fitness check this session added
   is shown red on a planted fixture before it is trusted green — the
   `workspace-rules.spec.ts` sandbox-directory pattern and the
   `as-platform-env-reader` fixture are the two concrete examples to copy.
2. **Where an approved document cannot be honoured, say so in the spec**
   rather than narrowing the check. No instance of this was needed in
   M0-01→07 — everything specified was achievable — but M0-09's
   `RenderValidator` adapter and the Tier-2/Tier-3 items in Tracks D and E
   will need it.
3. **A test found two real gaps this session**, not planted ones:
   `packages/contracts`/`packages/domain-types` missing scripts (M0-01), and
   `config.ts` not actually reading `process.env` until
   `loadConfigFromProcessEnv` was added to make F16's allowlist meaningful
   (M0-02). Both were fixed in the same task rather than deferred — a gate
   that finds a real defect and gets narrowed instead of the defect fixed is
   worse than no gate.
4. **Ports keep their in-memory doubles.** `InMemoryAuditRecorder`,
   `InMemoryReviewProgress`, `InMemoryMediaStore`, `InMemoryEntitlements`,
   `InMemoryIdempotencyStore` are all untouched. M0-07 added a production
   adapter *beside* the pattern, never in place of it.
5. **Domain returns typed Results; only infrastructure throws.**
   `platform/` is infrastructure — `token.ts` and `config.ts` still return
   `Result`-shaped values rather than throwing, because the callers (M0-06's
   resolver, eventually M0-12's composition root) need to branch on the
   failure, not catch it. `main.ts` (M0-13) will be the first place a
   `ConfigError` becomes a process exit.
6. **A failing or skipped test blocks the task. No quarantine.** Held this
   session without exception.

---

## Environment

- **Postgres is required — no Docker** (ADR-0004, amended at M0-20 when
  Compose is authored; not yet). Homebrew, **port 5433**, superuser
  `postgres`, databases `questionbank` and `questionbank_test`. Confirmed
  reachable and used for M0-07's integration specs this session.
- **`pnpm` is not on PATH — use `corepack pnpm`.**
- **There is no network.** `corepack pnpm install --offline` resolves from
  the store; confirmed stable both before and after M0-01/M0-02 added
  `vitest`/`typescript`/`@types/node` as devDependencies to `contracts` and
  `domain-types` (already present in `node_modules/.pnpm` from other
  projects' pins).
- `apps/studio` and `packages/content-renderer` are separate vitest projects.
- `apps/api` has two vitest projects: `unit` and `integration`. Integration
  specs share one database and reshape its schema, so they run one file at a
  time: `corepack pnpm vitest run --project integration <path>`. M0-07's two
  integration spec files were each run this way, then together via the full
  `pnpm -r test` at session close with no conflict.

---

## What still does not exist

- **No running application.** No `main.ts`, no composition root, no Compose,
  no CI. M0-08 through M0-14 are what build this.
- **No review workspace.** Still M4, untouched.
- **No validated golden set.** B1 still open — see below.

---

## Carried forward

### B1 — blocking gate, still open

Unchanged from HANDOFF-M4.md. **Do not attempt to source papers.**

### Debt

M0-01→07 closed nothing yet (D3, D9, D22, D27 are M0's to close, and none
has landed — D22 is M0-08, D27 is M0-09, D9 is M0-24, D3 is M0-15). No new
debt was created this session; D29–D32 (Item Editor unwired, navigation is
not a router, no OTLP exporter, no S3 `MediaStore` adapter) are all named in
the task breakdown already, for the tasks that will produce them (D31 is
already live in `telemetry.ts`'s header comment, ahead of its formal task).

D19–D21, D23–D26, D28 carried unchanged from HANDOFF-M4.md.
