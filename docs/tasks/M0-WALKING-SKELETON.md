# M0 — Walking Skeleton · Task Breakdown
**Milestone:** [ROADMAP.md](../ROADMAP.md) M0 · **Duration:** 3 weeks · **Depends on:** nothing
**Deployable:** *ROADMAP says "staging environment serving a trivial authenticated request". **Amended, and the amendment is the whole story of this milestone:** a **locally runnable** application serving a trivial authenticated request end to end, plus staging's infrastructure authored but never applied.*
**Status:** Draft, awaiting ratification. Fourteen opening decisions below; **none may be implemented before ratification.**

> 27 tasks, each independently testable. Paths follow [ENGINEERING-HANDBOOK.md](../ENGINEERING-HANDBOOK.md) §1–2.

**M0 is out of order and that is not neutral.** M1, M2 and M3 are merged and closed. Three milestones
have now reported acceptance criteria as failed-blocked on infrastructure M0 was supposed to have built
first ([ADR-0004](../adr/ADR-0004-local-postgres-pending-m0-compose.md), DEC-5, D3, D9, D22, D27). M0 is
the cheapest milestone left because most of its domain work has already been done *around* it; what
remains is wiring, and wiring is the thing nobody has done.

**M0 is also the milestone this environment can least afford to lie about.** Four of its five acceptance
criteria assume a container runtime, an observability backend, a CI provider and a cloud account, and
this machine has none of them. The governing rule for the whole breakdown is
[DEC-M0-1](#dec-m0-1--what-done-means-for-a-deliverable-that-cannot-be-executed-here): **an artifact we
cannot execute is proven by parsing it, never by asserting the property we cannot observe.** Nothing in
this document narrows a ROADMAP criterion so that it passes. Where a criterion cannot pass, it is marked
`Fail — blocked` with the missing resource named, exactly as M3 did for "an author produces a
stimulus-linked set in ≤ 20 min".

---

## Scope boundary

**M0 owns** `apps/api/src/platform/`, `apps/api/src/main.ts`, the composition seam on every context's
`public/`, `apps/studio`'s entry point and build, `infra/compose/`, `infra/terraform/`,
`.github/workflows/`, and the five gates it adds. It **starts** the application; it adds no domain rule,
no aggregate, no migration that reshapes a context schema, and no product feature.

**What M0 deliberately does not own:**

| Not in M0 | Owner | Why M0 can proceed without it |
|---|---|---|
| The Learn PWA shell | **M6** | See [DEC-M0-6](#dec-m0-6--the-learn-shell-is-deferred-to-m6-adr-0012). ROADMAP M0 names it; there is no student-facing feature until M6 and no `packages/attempt-engine` for it to host, so the shell would be a blank page with a manifest, rotting for five milestones |
| Turborepo | **deferred, with a trigger** | See [DEC-M0-2](#dec-m0-2--turborepo-is-deferred-adr-0011). `turbo` is not in `node_modules/.pnpm` and there is no network, so it is not installable today at any price |
| Identity — users, credentials, sessions, role assignment | **M8** | The auth stub *verifies* a token and projects it onto `PrincipalRef`. It never issues an identity. See [DEC-M0-7](#dec-m0-7--the-auth-stub-issues-and-verifies-a-principal-never-an-identity-adr-0014) |
| The S3/MinIO `MediaStore` adapter | **whoever first needs bytes in staging** | `@aws-sdk/client-s3` is not in the offline store. M0 ships a filesystem adapter that the composition root **refuses to select in production** — a boot failure, not a silent downgrade. New debt **D32** |
| An OTLP exporter and any Grafana wiring | **deferred, blocked** | No `@opentelemetry/*` package is in the offline store. M0 ships the port, the span tree and a recording double; the exporter is not written against an SDK we cannot compile against. New debt **D31**. See [DEC-M0-10](#dec-m0-10--otel-ships-as-a-seam-not-an-sdk) |
| Playwright E2E (**D2**) and browser-measured p95 (**D10**) | **still deferred** | Playwright is not in the offline store. M0 removes "there is no application to point a browser at"; it does not remove "there is no browser harness". D10's blocker is *renamed*, not cleared |
| Wiring the Item Editor's commands to the API | **next Studio task** | M0 wires **one** surface end to end — that is what a walking skeleton is. New debt **D29**, and it is what stands between here and the ≤ 20 min gate. See [DEC-M0-12](#dec-m0-12--which-blocked-timing-gates-m0-actually-unblocks) |
| A real router (TanStack Router) | **deferred, with a trigger** | Not in the offline store. M0 ships ~40 lines over the History API consuming M3-39's existing typed route table. New debt **D30** |
| Valkey, MinIO, PgBouncer, the queue relay as *running* services | **the machine that has Docker** | They are declared in the Compose file and asserted by parse. Nothing in the application depends on one being up |

---

## Decisions — proposed, not yet ratified

Fourteen questions the approved document set does not answer. Seven were named in the brief; seven more
surfaced while reading the tree. Each carries one recommendation.

**Standing instruction attached to every M0 task.** M0's characteristic failure is the **vacuous green** —
a gate that scans an empty set, a health check nobody ran, a boot time nobody measured. B1 is already one
of these and has been carried through three milestones. Where a check could be vacuous, it must assert
that it scanned something, and it must be shown red on a planted violation before it is claimed green.
Where it cannot be made non-vacuous, it is reported blocked. **Do not convert a blocked criterion into a
narrower passing one.**

### DEC-M0-1 · What "done" means for a deliverable that cannot be executed here

M0's deliverables split cleanly into things this machine can run and things it cannot, and the milestone
is worthless if the two are reported in the same voice.

**Recommended — three tiers, applied uniformly, recorded in ADR-0013:**

| Tier | Definition | Done means | May claim |
|---|---|---|---|
| **1 · Executable** | Runs here, against Node 22 and the Homebrew Postgres on 5433 | Merged with tests green, the normal bar | Everything it proves |
| **2 · Authored & asserted** | A real, committed artifact whose *semantics* a test can parse and check — a Compose service graph, a CI job list, an HCL resource set | The artifact exists, parses, and every assertion over it is **shown to fail on a planted mutation of the artifact itself** | Only what the parse proves. **Never a runtime property** |
| **3 · Unverifiable here** | Needs a machine, an account or a network we do not have | **Nothing.** Recorded `Fail — blocked`, naming the missing resource and the exact command that will be run when it exists | Nothing |

Three rules make the tiers binding rather than decorative:

1. **A Tier-2 artifact never claims a Tier-1 property.** The Compose file may be asserted to declare a
   health check on every service; it may not be described as booting, and no boot time appears anywhere
   in this repository until one is measured.
2. **Every Tier-2 task names its Tier-3 successor check** — the command that upgrades it — so the day the
   machine arrives, the work is a checklist and not an archaeology exercise.
3. **A Tier-3 item is carried in the Definition of Done as an unticked, explicitly blocked line**, not
   omitted. An omitted criterion is one nobody notices is missing.

### DEC-M0-2 · Turborepo is deferred (ADR-0011)

[TECH-STACK](../TECH-STACK.md) §1 selects "Turborepo + pnpm". The repo has a working pnpm workspace with
four projects (`apps/api`, `apps/studio`, `packages/content-renderer`, `tools/seed`) and per-project
vitest configuration that three milestones have been delivered against.

**Two facts decide this.** First, `turbo` is not in `node_modules/.pnpm`; with no network,
`corepack pnpm install --offline` cannot add it, so adoption is not churn-versus-benefit, it is
impossible today. Second — and this is the part that would still hold with a network — **everything
Turborepo sells is realised in CI**: remote caching, task-graph parallelism and change detection all pay
off against a runner's wall clock, and there is no CI runner here to measure the payoff on. Adopting it
now would add a configuration surface no test in this repository can exercise, in exchange for a benefit
no test in this repository can observe.

**Recommended:** `pnpm -r` stands, `package.json`'s three root scripts stand. Record the divergence from
TECH-STACK in **ADR-0011**, with a numeric trigger rather than "later": *the first CI run where
`pnpm -r test` exceeds the 10-minute feedback budget ([TECH-STACK](../TECH-STACK.md) §2), or the sixth
workspace project, whichever comes first.* A divergence from an approved document with no trigger is how
the document becomes unreliable — the same reasoning ADR-0010 records for ROADMAP M4.

### DEC-M0-3 · GitHub Actions, and the workflow adds no gate of its own

TECH-STACK §10 already selects GitHub Actions, so the provider is not the open question. **The open
question is what lives in the workflow**, given it can be written here and never run here.

**Recommended:** **GitHub Actions, and the workflow file is a thin caller containing zero assertions.**
Every gate stays in-repo under `apps/api/src/fitness/`, which is
[ADR-0002](../adr/ADR-0002-in-repo-boundary-checker.md)'s principle extended from the boundary checker to
the whole gate set. The workflow runs exactly what a developer runs:

```
corepack pnpm install --frozen-lockfile
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
corepack pnpm --filter @questionbank/api fitness
```

Three consequences, all of them the point:

- **A gate that exists only in YAML cannot be run locally and cannot be tested here.** Every gate in
  `apps/api/src/fitness/` is a vitest spec that fails red on a planted fixture; a `grep … && exit 1`
  step in a workflow is a gate with no test and no local equivalent.
- **Switching provider costs ~40 lines of YAML**, because the gates are provider-agnostic. That is the
  real answer to "which provider, given we can never run it": pick the one the stack already names, and
  make the choice cheap to reverse rather than agonise over it.
- **The workflow's own correctness is a Tier-2 assertion** — M0-19 parses `.github/workflows/ci.yml` and
  checks the job set, that every workspace project is covered, that no job carries `continue-on-error`,
  that no gate sits behind a conditional, and **that no `run:` step contains an assertion of its own**.
  Planted violation: an inline `grep`-based check, or `continue-on-error: true`.

### DEC-M0-4 · ADR-0004 is **amended in place**, not superseded

A Compose file nobody can run does not change one fact ADR-0004 records: integration tests here execute
against a Homebrew Postgres on port 5433, and the verification ADR-0004 itself names — *bring up Compose,
leave `DATABASE_URL` unset, confirm the suites and `pnpm seed` pass on 5432* — **remains unrun**.

**Recommended:** ADR-0004 keeps `Status: Accepted` and gains an `## Amended by M0 (2026-08-…)` section
stating exactly three things: the Compose file now exists and publishes 5432; the two `DATABASE_URL`
defaults are unchanged and still point at 5432, so the file is the documented target; **F8 remains
failed-blocked and the named verification is still outstanding.** ADR-0004 is superseded by the first
green Compose boot and by nothing else — and because the ADR already names that run, the supersession is
a one-line edit when it happens.

Writing a new ADR that declares the old problem solved, while the old problem's consequence is still
live, would be the worse move by a distance.

### DEC-M0-5 · The composition root lives in `platform/`, and reaches contexts through a fourth barrel export (ADR-0015)

`apps/api/src/platform/` does not exist. Neither does `main.ts`. Every context already exposes exactly
the shape a root needs — `ContentModule.register({ handlers, principals })` builds a `HandlerRegistry`
that **throws** on a handler with no policy — but nothing calls it outside integration specs.

**Recommended layout**, per Handbook §1:

```
apps/api/src/
├── main.ts                          # ~12 lines: read config, create, listen, trap signals
└── platform/
    ├── config/         config.ts            # the only reader of process.env (F16)
    ├── auth/           token.ts, principal-resolver.ts
    ├── observability/  logger.ts, serializer.ts, telemetry.ts
    ├── persistence/    pool.ts, clock.ts, identifiers.ts, audit-recorder.ts, idempotency-store.ts
    ├── http/           health.controller.ts
    └── composition/    app-factory.ts       # createApplication(config, overrides?)
```

**The seam question is the hard part.** Handbook §1 says a barrel exports exactly three things —
commands, queries, events — so a context's Nest module and its repositories are *not* reachable through
`public/`. A composition root that imports `contexts/content/api/content.module.js` and four repository
files directly violates **F1**, the oldest gate in the repository.

The two ways out are not equal. Amending F1 with a closed exception for one file weakens a load-bearing
gate to make new code fit. **Recommended instead:** each context gains
`public/composition.ts` — a `register(deps)` that composes *its own* internals and returns a
`DynamicModule`. The root then imports only `contexts/*/public/composition.js`, F1 is untouched, and
adding a repository never edits the root.

Two conditions, both asserted:

1. `public/composition.ts` is a **separate subpath from `public/index.ts`**, and a spec asserts
   `index.ts` does not import it — otherwise `m4-seam.spec.ts` and every other barrel consumer starts
   transitively loading NestJS and Express to read a command type.
2. **`platform/composition/` may import `contexts/*/public/` and nothing deeper**, asserted by extending
   the F1 scan to `platform/`. Planted violation: an import of
   `contexts/content/infrastructure/item.repository.js` from the root.

This is what turns 3,663 passing tests into a running application, and it is what **D27** needs
(M0-08).

### DEC-M0-6 · The Learn shell is deferred to M6 (ADR-0012)

ROADMAP M0 names "Learn and Studio app shells". There is no `apps/learn` in the repository.

**Recommended: not in scope.** Three reasons, in order of weight. ROADMAP's own sequencing rule 1 says
M1–M5 ship no student-facing feature, so a Learn shell has nothing to render until M6 and would spend
five milestones rotting. Learn is a PWA whose defining pieces — the service worker, the offline attempt
engine (`packages/attempt-engine`, which does not exist) — are not M0's and are not buildable here.
And M0's own acceptance is *one trivial authenticated request*, which Studio already has a shell for
(M3-39) and Learn does not.

Divergence from an approved ROADMAP deliverable, so it goes in **ADR-0012**, with the trigger being M6's
first task. **Consequence, stated plainly:** F26 (Attempt Engine has zero framework imports) and F24 on
Learn's token layer have no subject in M0. F26 is handled at M0-23 rather than reported green over an
empty set.

### DEC-M0-7 · The auth stub issues and verifies a **principal**, never an identity (ADR-0014)

`PrincipalRef` is one of the shared kernel's three types and every context already depends on it.
`PrincipalResolver` is declared in three places (`content/api/http-runner.ts` and the curriculum and
scoring equivalents) and **implemented only in integration specs**. That interface is the hole the stub
fills, and its shape decides how far the stub can sprawl.

**Recommended:** an HMAC-SHA256 bearer token over a canonical JSON payload, signed and verified with
`node:crypto` — `jose` and `jsonwebtoken` are not in the offline store, and this needs no library.

- **Claims, closed:** `sub` (`UserId`), `kind` (`PrincipalKind`), `roles` (`RoleSet`), `iat`, `exp`,
  `iss`, `jti`. **The verified result is a `PrincipalRef` and nothing else** — no claim survives
  verification that the shared kernel does not name, so nothing downstream can start depending on a
  claim the kernel would have to grow to carry (§9 rule 5).
- **What it is not:** no user table, no password, no refresh rotation, no revocation list, no role
  assignment. Who is entitled to a signed token is Identity's question in M8. A stub that grew a user
  store would be M8's context, built by M0, in the wrong place, by someone who had not read M8's brief.
- **Rules, each individually testable:** an expired token is refused at the boundary; an unknown `kind`
  is refused and never coerced to `human`; a tampered payload fails the MAC; a token with no signature,
  or a signature segment of length zero, is refused rather than skipped; the signing key is read only
  through the typed config module (F16) and **has no default** — a development fallback secret in source
  is a committed secret and F39 must catch it.
- **`kind: 'ai_agent'` tokens verify normally** (D10 — machines act, and provenance records it). INV-01
  is enforced in content's publication path and the stub must not become a second place that decides
  who may publish. A test asserts the resolver has no knowledge of publication.

### DEC-M0-8 · Compose publishes 5432; the Homebrew cluster stays on 5433

**Recommended:** leave both `process.env['DATABASE_URL'] ?? 'postgres://…:5432/…'` defaults at
`apps/api/src/testing/database.ts:15` and `tools/seed/index.ts:117` exactly as they are. Compose
publishes 5432. Developers keep exporting `DATABASE_URL` for the 5433 cluster. The runtime path moves
behind the typed config module (M0-02); **test support keeps its own default**, because ADR-0004 already
records that these two files are test/tool support and not shipped runtime, and F16 should say so by
enumeration rather than by an exception nobody can find.

Renumbering the local cluster to make an unrunnable file look tidy would invalidate the environment
section of three handoffs. Do not.

### DEC-M0-9 · What the Compose file is *asserted* to contain

The strongest Tier-2 artifact in the milestone, so its assertions carry the most weight. `yaml@2.9.0` is
in the offline store, so the file is parsed, not grepped.

**Recommended assertions over `infra/compose/docker-compose.yml`:**

- The service set **equals** a closed constant: `postgres`, `valkey`, `minio`, `ai-fixture`, `api`,
  `studio`. Equality, not containment — a service added without editing the constant fails.
- Every service declares a `healthcheck` with all four of `test`, `interval`, `timeout`, `retries`, plus
  `start_period`.
- **Every `depends_on` uses `{ condition: service_healthy }`.** A bare list form is a violation, because
  a bare list is precisely the mistake that makes a ten-minute boot claim untrue while looking correct.
- Images are pinned by tag and match [TECH-STACK](../TECH-STACK.md) §14's local equivalents
  (`postgres:16`, `valkey`, `minio`); **no `latest`, anywhere.**
- No two services publish the same host port; every published port appears once; `postgres` publishes
  5432 (DEC-M0-8).
- The dependency graph is acyclic.
- No secret literal (shares F39's scanner, M0-21).

**Planted violation:** replace one `condition: service_healthy` with the bare list form — the spec goes
red. **What none of this proves:** that any of it boots. **F8 stays `Fail — blocked`.**

### DEC-M0-10 · OTel ships as a seam, not an SDK

Verified against `node_modules/.pnpm`: **there is no `@opentelemetry/*` package in the offline store**,
and no network to fetch one. "OpenTelemetry wiring end to end" cannot import the OTel SDK this milestone.

**Recommended:** M0 ships the **port and the span tree**, not the vendor. `platform/observability/`
declares `Telemetry` with the two operations the codebase actually needs (`startSpan(name, attributes)`,
`withSpan(name, attributes, fn)`), a JSON-logging implementation, and a recording double for tests. The
correlation id `http-runner.ts` already echoes on every response becomes the trace correlation, which
means the seam is not invented — it is named.

**Fully testable now:** one authenticated request through the composed application emits exactly one root
span carrying the route, one child per handler, one child per repository call against real Postgres; every
span carries the same correlation id, and that id equals the `X-Correlation-Id` response header; and **no
span attribute matches a PII pattern**, sharing the allowlist serializer's rule (§9 rule 12).

**Not written:** an `OtlpTelemetry` adapter. Writing an exporter against an SDK we cannot compile against
produces a file that has never been type-checked against the API it claims to implement — worse than its
absence, because it looks finished. New debt **D31**, trigger: the OTel SDK becoming installable.

**Consequence:** ROADMAP's "one request traced from client through API to database in Grafana" is
`Fail — blocked` on two independent missing resources — the SDK and the Grafana account.

### DEC-M0-11 · Terraform is authored and **linted**, and the lint is not called validation

`terraform validate` requires `terraform init`, which downloads provider plugins, which requires network.
There is no HCL parser in the offline store either. So Terraform is Tier 2 with a weaker instrument than
Compose gets, and pretending otherwise would be the exact failure this milestone exists to stop.

**Recommended:** author `infra/terraform/staging/` for **one deployable** — the API on ECS Fargate, its
RDS PostgreSQL 16 instance, the security groups and the ECR repository — and assert only what a text scan
can honestly assert: every resource carries `Environment = "staging"` tags; no access key, secret or
connection string literal (F39's scanner again); `region` is a variable whose default is `ap-south-1`;
`aws_db_instance.engine` is `"postgres"`, never an Aurora engine (TECH-STACK §3's one-way-door rule); the
state backend is declared and is not local.

**The spec's own header says this is a lint, not a validation**, and the task names its Tier-3 successor
verbatim: `terraform init && terraform validate && terraform plan -var-file=staging.tfvars`. Do not dress
a grep up as validation.

*Considered and rejected:* deferring Terraform entirely. The authoring is what makes the first staging
deploy a day rather than a week, and it costs almost nothing to write while the shape of the deployable
is fresh.

### DEC-M0-12 · Which blocked timing gates M0 actually unblocks

Two milestones report timing criteria as failed-blocked, and both name M0. The honest answers differ.

| Gate | Today | After M0 | Why |
|---|---|---|---|
| **"An author produces a stimulus-linked set in ≤ 20 min"** (M3, DEC-5) | `Fail — blocked` on D3/M0 | **`Fail — blocked` on D29**, a named one-task remainder | M0 delivers the API, the build, the entry point and the typed client — but wires **one** surface, per the definition of a walking skeleton. The Item Editor's commands remain unwired. The blocker shrinks from "there is no application" to "one editor is not connected", and **that renaming is a deliverable**: it is the difference between a criterion blocked on a milestone and one blocked on an afternoon |
| **"40 items/hour reviewing, 3 real reviewers"** (M4) | `Fail — blocked` | **`Fail — blocked` on M4** | There is no review workspace to time. M0 changes nothing here, and M4 must not read M0's landing as permission to claim it. **The blocker moves from M0 to M4's own scope** |
| **D2 — Playwright E2E** | Deferred | **Still deferred** | Playwright is not in the offline store. Unchanged by M0 |
| **D10 — browser-measured p95** | Deferred | **Still deferred, blocker renamed** | M0 supplies a real app in a real browser; there is still no automation harness to measure p95 with, and a number read off a devtools panel once is not a gate |

**Recommended:** state all four in the close-out in exactly these words. M0 must not claim it unblocked a
criterion it merely moved.

### DEC-M0-13 · Studio gets navigation, not a router (D30)

TanStack Router is not in the offline store. M3-39 already built `apps/studio/src/shell/navigation.ts` as
a typed route table the shell consumes as data — which was the right call and is now load-bearing.

**Recommended:** ~40 lines over `history.pushState` and `popstate` that map the existing table to a
rendered destination. Explicitly **not** a router: no nested layouts, no loaders, no code splitting, no
search-param validation. It is small enough to delete in an afternoon, and the route table is already in
the shape TanStack Router consumes, so the replacement is a swap rather than a rewrite. Debt **D30**,
trigger: the first nested route, or the first surface needing validated search state beyond M3-43's
existing URL filters.

### DEC-M0-14 · No M0 gate may be satisfied by weakening an existing one

Not a question the documents leave open — a constraint with three specific tripwires visible from here,
each worth naming before someone hits it at 6pm on a Friday.

1. **Adding `react` and `react-dom` to `apps/api`** (M0-08 needs them for `renderToStaticMarkup`) must
   not relax F1 or F2. The adapter lives in `contexts/content/infrastructure/`; `domain/` still imports
   nothing; the renderer package is still the one implementation (F20 re-run).
2. **Adding `platform/`** gives the F1 scanner a directory it has never seen. It must be **added to the
   scan**, not excluded from it — with the rule of DEC-M0-5 condition 2. An `excludePatterns` entry for
   `platform/` would silently unenforce the newest and least-reviewed code in the repository.
3. **The `questionbank_app` role landing locally** (M0-22) makes F7/F40 non-vacuous and simultaneously
   *invalidates* the existing test that asserts the role is absent. That test must be rewritten to assert
   the role is present and holds the right grants — never deleted, and never left asserting a falsehood.

---

## Task Index

| ID | Task | Track | Tier | Depends on |
|---|---|---|---|---|
| M0-01 | The monorepo as it stands — **ADR-0011** | A · ground | 1 | — |
| M0-02 | `platform/` skeleton & the typed config module (F16) | A · ground | 1 | 01 |
| M0-03 | Structured logging & the allowlist serializer | A · ground | 1 | 02 |
| M0-04 | The `Telemetry` port, spans & the correlation id (DEC-M0-10) | A · ground | 1 | 03 |
| M0-05 | Auth stub — token issue & verify — **ADR-0014** | A · ground | 1 | 02 |
| M0-06 | `PrincipalResolver` production adapter | A · ground | 1 | 05 |
| M0-07 | Production `Clock`, `IdentifierFactory`, `AuditRecorder` | B · root | 1 | 02 |
| M0-08 | Durable `IdempotencyStore` — **closes D22** | B · root | 1 | 07 |
| M0-09 | `RenderValidator` production adapter — **closes D27** | B · root | 1 | 07 |
| M0-10 | `MediaStore` filesystem adapter & the production refusal | B · root | 1 | 07 |
| M0-11 | Composition seam on every barrel — **ADR-0015** | B · root | 1 | 07–10 |
| M0-12 | `createApplication` — the composition root (F11 at boot) | B · root | 1 | 11, 06, 04 |
| M0-13 | `main.ts`, health, readiness & graceful shutdown | B · root | 1 | 12 |
| M0-14 | **The walking skeleton** — one authenticated request, end to end | B · root | 1 | 13 |
| M0-15 | Studio `index.html`, `main.tsx`, Vite config & build — **closes D3** | C · studio | 1 | — |
| M0-16 | Navigation over the History API (DEC-M0-13) | C · studio | 1 | 15 |
| M0-17 | The typed HTTP client — F15's subject | C · studio | 1 | 15 |
| M0-18 | Studio design tokens & F24 | C · studio | 1 | 15 |
| M0-19 | One surface wired end to end | C · studio | 1 | 17, 18, 14 |
| M0-20 | Compose stack & the spec that parses it — **ADR-0013**, ADR-0004 amendment | D · infra | **2** | 13 |
| M0-21 | CI workflow & the spec that parses it (DEC-M0-3) | D · infra | **2** | 20 |
| M0-22 | Terraform for staging & the scan it can honestly carry | D · infra | **2** | 20 |
| M0-23 | Secrets discipline & F39 | D · infra | 1 | 20, 21, 22 |
| M0-24 | The `questionbank_app` role & F7/F40 — **closes D9** | E · gates | 1 | 12 |
| M0-25 | F26 and the attempt engine that does not exist | E · gates | 1 | — |
| M0-26 | The M0 gate module, planted fixtures & thresholds | E · gates | 1 | 02, 12, 18, 23, 24, 25 |
| M0-27 | Day One verified, ADRs, traceability & close-out | E · gates | 1 | all |

---

## Track A — Ground

*Everything here lands under `apps/api/src/platform/`, which contains **zero business logic** (Handbook §1).
A rule that belongs to a context and is written here is written in the wrong place, and M0-26's scan says so.*

### M0-01 · The monorepo as it stands
**Objective** Assert what the workspace already does, and record the divergence from TECH-STACK rather than leaving it implicit (DEC-M0-2).
**Files** `docs/adr/ADR-0011-pnpm-workspace-stands-in-for-turborepo.md`, `package.json`, `apps/api/src/fitness/workspace-rules.ts`, `workspace-rules.spec.ts`
**Acceptance**
- **ADR-0011** written: the divergence, the two reasons (not installable offline; the benefit is only observable in a CI run that does not exist), and the numeric trigger — `pnpm -r test` exceeding 10 minutes in CI, or a sixth workspace project
- A spec asserts `pnpm-workspace.yaml`'s globs cover every directory containing a `package.json` under `apps/`, `packages/` and `tools/` — a project added outside the globs fails here rather than at somebody's first confusing install
- Every workspace project declares both `test` and `typecheck` scripts; a project without one fails
- **`corepack pnpm install --offline` succeeds from the store** and the lockfile is unchanged afterwards — asserted as a documented command in the ADR, run once before the milestone starts. If it fails, **M0-09 is blocked and this is where that is discovered**, not four tasks later
**Tests** Unit: the glob/`package.json` cross-check, red on a planted project outside the globs · missing-script detection, red on a planted project

### M0-02 · `platform/` skeleton & the typed config module (F16)
**Objective** §9 rule 17 — no configuration read outside the typed config module — and the one place a secret enters the process.
**Files** `apps/api/src/platform/config/config.ts`, `config.spec.ts`
**Acceptance**
- Six-directory anatomy created: `config/`, `auth/`, `observability/`, `persistence/`, `http/`, `composition/`
- `loadConfig(env): Result<AppConfig, ConfigError>` — **total, and it returns rather than throws**; `main.ts` is the only caller that turns a failure into an exit
- Keys: `databaseUrl`, `port`, `nodeEnv`, `authSigningKey`, `authIssuer`, `authTokenTtlSeconds`, `mediaStorageRoot`, `logLevel`. Closed set, `as const`
- **No key has a default that would be unsafe in production.** `authSigningKey` has no default at all; a missing one is a `ConfigError` naming the key, and the message contains no value
- `nodeEnv` is a closed union; an unrecognised value is rejected, never coerced to `development`
- Every value is validated at load — a non-numeric `port`, a `databaseUrl` that is not a URL, a `authSigningKey` under 32 bytes — each with its own error
- **F16, as an enumerated allowlist:** the only files permitted to read `process.env` are `platform/config/config.ts`, `apps/api/src/testing/database.ts` and `tools/seed/index.ts`. The last two are test/tool support and not shipped runtime, which ADR-0004 already records; the list is a closed constant and a new reader fails the check
**Tests** Unit: every key loads · every key's validation failure, individually · missing signing key is an error and the message contains no value · unknown `nodeEnv` rejected · error is returned not thrown · F16's scan red on a planted `process.env` read inside a handler

### M0-03 · Structured logging & the allowlist serializer
**Objective** Handbook §7 and §9 rule 12 — a denylist fails open on the first unanticipated field, so this is an allowlist.
**Files** `platform/observability/logger.ts`, `serializer.ts`, `serializer.spec.ts`
**Acceptance**
- JSON to stdout, one object per line: `timestamp`, `level`, `message`, `correlationId`, `context`, plus an allowlisted attribute bag
- **The serializer emits only allowlisted keys.** An unknown key is dropped, and its *name* is recorded once as `droppedKeys` so the omission is visible without the value ever being
- Dropping is recursive — a nested object under an allowlisted key is filtered by the same rule, because the first PII leak the category ships is a whole entity spread under a permitted key
- No `Error` is logged with its stack in production `nodeEnv`; the message and error code always
- **A planted PII fixture** — a record carrying `email`, `phone` and `fullName` — produces output containing none of the three values
- `logLevel` comes from the typed config module and nowhere else
**Tests** Unit: allowlisted key survives · unknown key dropped and named · nested unknown key dropped · PII fixture leaks nothing, asserted per field · level filtering · red on a planted denylist-shaped serializer

### M0-04 · The `Telemetry` port, spans & the correlation id
**Objective** ROADMAP's "OpenTelemetry wiring end to end", as far as an offline store allows (DEC-M0-10).
**Files** `platform/observability/telemetry.ts`, `recording-telemetry.ts`, `telemetry.spec.ts`
**Acceptance**
- `Telemetry` declares `startSpan(name, attributes)` and `withSpan(name, attributes, fn)`. Two operations, on the same argument SQS gets four in TECH-STACK §6 — a narrow port is a substitutable one
- A `JsonTelemetry` implementation writes spans through M0-03's serializer, so **span attributes are filtered by the same allowlist as logs**. One rule, one implementation
- `RecordingTelemetry` captures the tree for assertions and names its real owner in a header comment, per the ports-over-adapters convention
- The **correlation id already echoed by `http-runner.ts`** is the trace id; a span cannot be started without one
- **No OTLP exporter is written** (DEC-M0-10), and the file header says why, naming **D31**
- `withSpan` records the failure and re-raises without swallowing; a span is closed on the throwing path, asserted
**Tests** Unit: span tree shape · attributes filtered identically to logs, asserted against the same PII fixture · span closed on throw · missing correlation id refused · a spec asserts no `@opentelemetry` import exists anywhere, so a half-wired SDK cannot arrive unnoticed

### M0-05 · Auth stub — token issue & verify (ADR-0014)
**Objective** DEC-M0-7. The narrowest thing that makes "authenticated request" true.
**Files** `platform/auth/token.ts`, `token.spec.ts` · **plus `docs/adr/ADR-0014-the-auth-stub-issues-a-principal-not-an-identity.md`**
**Acceptance**
- `issue(claims, config): string` and `verify(token, config): Result<PrincipalRef, AuthError>` — HMAC-SHA256 over canonical JSON via `node:crypto`, base64url, three segments
- Claims closed: `sub`, `kind`, `roles`, `iat`, `exp`, `iss`, `jti`
- **`verify` returns a `PrincipalRef` and nothing else** — a spec asserts the return type's keys equal `{ kind, id, roleContext }`, so no claim leaks past the shared kernel (§9 rule 5)
- Refused, each with a distinct code and each individually tested: expired; `iss` mismatch; unknown `kind`; malformed segment count; **empty signature segment**; signature over a different payload; a payload whose `roles` is not an array of strings
- **An unknown `kind` is refused, never coerced.** `ai_agent` verifies normally (D10); a test asserts nothing in this module knows what publication is (INV-01 is content's, and one enforcement point only)
- Comparison is constant-time (`timingSafeEqual`), and the lengths are checked before the compare so it cannot throw
- The signing key arrives only through M0-02's config; **no default, no fallback, no test key in source** (F39)
- **ADR-0014** records what the stub is not: no user store, no password, no refresh, no revocation, no role assignment — all M8's — and names the trigger for replacement
**Tests** Unit: round-trip issue→verify · every refusal above, separately · `PrincipalRef` key set asserted · tampered payload · tampered signature · `alg`-free format cannot be coerced · timing-safe compare on mismatched lengths does not throw · 100% branch (ADR-0008 — this decides who is who)

### M0-06 · `PrincipalResolver` production adapter
**Objective** Fill the interface three contexts declare and only specs implement.
**Files** `platform/auth/principal-resolver.ts`, `principal-resolver.spec.ts`
**Acceptance**
- Reads `Authorization: Bearer <token>`, verifies via M0-05, returns `PrincipalRef` or `null` — `null` is what `http-runner.ts` already turns into a 401, so no new error path is invented
- A missing header, a non-`Bearer` scheme, and a `Bearer` with no token are each `null`, and **each is logged at the same level with the same shape**, so an attacker cannot distinguish them by log volume or response
- **The token never reaches a log, a span attribute or an error message** — asserted, not reviewed
- One instance is shared by all three contexts; a spec asserts the resolver has no context-specific branch
**Tests** Unit: valid header resolves · each malformed header shape yields `null` · token absent from log and span output, asserted against the recording double · expired token yields `null` and logs a distinguishable *reason* internally while returning the same outward result

---

## Track B — The composition root

### M0-07 · Production `Clock`, `IdentifierFactory`, `AuditRecorder`
**Objective** Three ports every context declares and none implements outside tests.
**Files** `platform/persistence/clock.ts`, `identifiers.ts`, `audit-recorder.ts`, `pool.ts`, + specs · `infra/migrations/2026…_platform_audit.sql`
**Acceptance**
- `SystemClock` — the only `new Date()` in the application; the domain-has-no-clock rule stays enforced because this is `platform/`
- `UuidIdentifierFactory` over `node:crypto.randomUUID`
- **`PostgresAuditRecorder`** writing to `platform.audit_record`, append-only, with the grants F7/F40 will check at M0-24. Audit that vanishes on restart is not audit, and the in-memory recorders were always labelled as doubles
- The migration adds a `platform` schema, is expand-only and reversible (MNT-14), and adds **no cross-schema foreign key** (F2)
- `pool.ts` builds one `pg.Pool` from config, with `max`, timeouts, and a `close()` M0-13's shutdown calls
- Each of the three names its interface's owning contexts in a header comment — one adapter serving three declarations is deliberate, and the next reader needs to know it is not a copy
**Tests** Unit: clock monotonic across calls · identifiers unique and v4-shaped · Integration: an audit record round-trips; an UPDATE against it is refused; the pool closes cleanly and a query after close fails predictably

### M0-08 · Durable `IdempotencyStore` — closes D22
**Objective** **D22** — the idempotency store is process-local, which means it stops working the moment there is more than one process, i.e. the moment M0 succeeds.
**Files** `platform/persistence/idempotency-store.ts`, `idempotency-store.integration.spec.ts` · `infra/migrations/2026…_platform_idempotency.sql`
**Acceptance**
- Implements the existing `IdempotencyStore` port from `contexts/content/application/ports.ts` **unchanged** — a port that has to move to get an adapter was the wrong port
- Postgres-backed, keyed by idempotency key, storing the recorded outcome and an expiry
- **Concurrent duplicate requests resolve to one execution**, enforced by a unique constraint and not by a read-then-write, asserted with two overlapping transactions
- Expired entries are ignored on read and reaped on a schedule the composition root does not need to own yet
- `InMemoryIdempotencyStore` stays, still labelled a double, and a spec asserts both satisfy the same behavioural contract — one shared spec, two subjects
**Tests** Integration: replay returns the recorded outcome without re-executing · two concurrent inserts, one winner · expiry honoured · the shared contract spec passes for both implementations

### M0-09 · `RenderValidator` production adapter — closes D27
**Objective** **D27**, named at `application/ports.ts:105` as "a composition gap rather than a design one". This is that gap, closed.
**Files** `contexts/content/infrastructure/render-validator.adapter.ts`, `render-validator.adapter.spec.ts`, `render-validator.adapter.integration.spec.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/fitness/platform-rules.ts`

**Correction, recorded rather than silently fixed.** This entry originally claimed *"`renderFor` uses
`renderToStaticMarkup`, so no JSX transform is needed in the API build."* That is false, and the falseness
was concrete: `apps/api`'s own `tsc --noEmit` refused the moment the adapter imported `render-validation.ts`,
because `renderFor` calls `ContentRenderer(...)`, defined in `content-renderer.tsx` — resolved to **source**,
not a pre-built `.d.ts`, since this repository has no build step for internal packages. D27's own comment
already said the true reason ("running a React render inside the Node service"); this entry mis-stated what
that implied. **ADR-0016** records the actual decision — `apps/api/tsconfig.json` gets `"jsx": "react-jsx"`,
narrowed by a fitness function (`checkNoTsxFiles`) asserting zero `.tsx` files exist under `apps/api/src/`,
so the concession stays "type-check one imported package" and never becomes "the API authors views." A
second, independent defect surfaced in the same typecheck run — `MediaBlock.caption` typed `string` on the
renderer and `readonly Inline[]` on the domain, undetected for a milestone because `renderer-seam.spec.ts`
only ever compared kind *names*, never a variant's *shape*. Both are fixed and closed (see
`fix(content): render a media caption as authored inlines` and
`test(content): assert the renderer seam field by field`) as prerequisites to this task, not as part of it.

**Acceptance**
- Implements `RenderValidator` by calling `validateRender` from `@questionbank/content-renderer/render-validation`. It is plain TypeScript and contains no JSX itself — the JSX capability lives in `apps/api/tsconfig.json` (ADR-0016), needed because `validateRender`'s own import chain reaches `content-renderer.tsx`, not because this file writes any
- `react`, `react-dom` and `@types/react` added to `apps/api` dependencies, all present in `node_modules/.pnpm`, resolving offline. **If that install fails, this task is blocked and says so** — the adapter does not move to a worker to route around it
- **The adapter contains no rendering logic** — it maps `ItemVersion` to `ContentBody`, calls, and maps the verdict back. F20 (exactly one `ContentRenderer`) is re-run and still green
- Lives in `infrastructure/`, so `domain/` still imports nothing (F2) and the boundary scan is unchanged
- A render failure on **any** surface produces a blocking verdict, matching what `render-validation.ts` already documents — the adapter must not soften it to a warning
- The port's D27 comment block is rewritten to describe what exists, not what is missing
- **`checkNoTsxFiles`** (`fitness/platform-rules.ts`) asserts zero `.tsx` files under `apps/api/src/`, proven red on a planted fixture — the boundary that keeps the JSX concession from widening
**Tests** Unit: a valid body validates on all four surfaces · a body that fails one surface produces a blocking verdict naming it · the adapter is shown to delegate — a spec asserts it declares no JSX and no element construction · **the publication precondition, previously fed by a test-supplied fact, now runs against the real adapter** in an integration spec

### M0-10 · `MediaStore` filesystem adapter & the production refusal
**Objective** A real adapter for the one port whose production implementation is not installable.
**Files** `platform/persistence/filesystem-media-store.ts`, + spec
**Acceptance**
- Implements `MediaStore` against `mediaStorageRoot` from config; keys are content-addressed by checksum so the storage layout matches what S3 will use
- **The composition root refuses to select it when `nodeEnv` is `production`** — a `ConfigError` at boot, not a warning and not a silent downgrade. A boot failure is the only refusal a hurried deploy cannot ignore
- Path traversal in a storage key is rejected before any filesystem call
- The header names **D32** and `@aws-sdk/client-s3` as the successor
**Tests** Unit: put/get/delete round-trip · traversal rejected, several shapes · missing key returns the port's absence value, never throws · Integration: `createApplication` with `nodeEnv: 'production'` and a filesystem store **fails to boot**, asserted

### M0-11 · Composition seam on every barrel (ADR-0015)
**Objective** DEC-M0-5 — let the root wire contexts without F1 being amended.
**Files** `contexts/{content,curriculum,scoring}/public/composition.ts` · `docs/adr/ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md`
**Acceptance**
- Each context exports `register(deps): DynamicModule`, composing **its own** handlers, repositories and adapters. Adding a repository never edits the root
- `deps` is a typed per-context interface naming exactly the platform ports that context needs — content's names `RenderValidator`, `MediaStore`, `IdempotencyStore`; scoring's does not
- **`public/index.ts` does not import `public/composition.ts`**, asserted by a spec, so `m4-seam.spec.ts` and every other barrel consumer stays free of NestJS and Express
- **ADR-0015** records the divergence from Handbook §1's "exactly three things", the alternative rejected (a closed F1 exception for the root file), and why amending documentation beats amending a gate
- Content's `register` wires `NoReviewProgress` (always `false`, M4's to replace — the behaviour W4 already documents) and a deny-by-default `Entitlements` for paid depth only. **Basic correctness is never asked about** (INV-08), asserted
**Tests** Unit per context: `register` returns a module whose registry resolves every handler · `index.ts`'s import graph excludes the module, red on a planted re-export · content's `register` rejects a `deps` missing `RenderValidator` at the type level *and* at runtime

### M0-12 · `createApplication` — the composition root (F11 at boot)
**Objective** The single function that turns 3,663 passing tests into an application.
**Files** `platform/composition/app-factory.ts`, `app-factory.spec.ts`, `app-factory.integration.spec.ts`
**Acceptance**
- `createApplication(config, overrides?): Promise<INestApplication>` composes all three contexts' `register`, the platform adapters, the resolver and telemetry. **Overrides exist for tests only** and a spec asserts the production path passes none
- **F11 / §9 rule 6 at the application level:** a handler with no declared policy makes `createApplication` reject. Each context's `HandlerRegistry` already throws; M0 proves it **across the composed set**, which is the first time the whole handler population has ever been in one place
- **The application is buildable without a listening socket** — every assertion below runs against the factory, not against a port, so the gate is a unit-speed one
- **F1 extended to `platform/`:** `platform/composition/` may import `contexts/*/public/**` and nothing deeper
- No business rule in `platform/` — a scan asserts no file under `platform/` imports a context `domain/` module
**Tests** Unit: the application builds · a planted policy-less handler makes it reject, naming the handler · the production path passes no overrides · Integration: the composed app resolves every handler and executes one against real Postgres · the F1 extension red on a planted deep import of `contexts/content/infrastructure/item.repository.js`

### M0-13 · `main.ts`, health, readiness & graceful shutdown
**Objective** The process. Twelve lines of it.
**Files** `apps/api/src/main.ts`, `platform/http/health.controller.ts`, + spec
**Acceptance**
- `main.ts` loads config, exits non-zero with the config error's message on failure, creates, listens, and traps `SIGTERM`/`SIGINT`. **No branch, no rule, no try/catch around business logic**
- `GET /healthz` — liveness, no dependency touched, always 200 once the process is up
- `GET /readyz` — readiness, executes `SELECT 1` and returns 503 with a machine-readable reason when the database is unreachable. **These are two different questions and Compose's health checks depend on the difference**, which is why they are two routes
- Neither route requires authentication; both are asserted absent from the OpenAPI documents, since they are operational and not contract
- Shutdown drains in-flight requests, closes the pool, and exits 0 within a bounded time
**Tests** Integration: `/healthz` 200 · `/readyz` 200 against real Postgres · `/readyz` 503 against a closed pool, with the reason asserted · SIGTERM drains an in-flight request before exiting · Unit: `main.ts` exits non-zero on a config error

### M0-14 · The walking skeleton — one authenticated request, end to end
**Objective** The milestone's name, as one test.
**Files** `apps/api/src/platform/walking-skeleton.integration.spec.ts`
**Acceptance**
- One request, through the **real** composed application: bearer token issued by M0-05 → resolver → controller → handler with its declared policy → repository → **real Postgres** → response
- The response carries `X-Correlation-Id`, and **that id appears on every span in the emitted tree**, asserted against `RecordingTelemetry`
- The span tree is asserted by shape: one root naming the route, one child per handler, at least one child naming a database call
- **No answer key in the response** — the delivery route is used, and the existing F6/F35 assertion is re-run against live output from the composed app rather than from a test harness
- **The unauthenticated request is asserted too**: no token → 401, no span leaking the attempted path's parameters, nothing in the log matching the PII fixture
- The spec's header states, in one sentence, exactly what it does **not** prove: that any of this runs anywhere but this machine
**Tests** Integration: authenticated 200 with the assertions above · unauthenticated 401 · expired token 401 · a planted removal of the resolver from the composition makes the 401 case fail, so the check is shown able to fail

---

## Track C — Studio as an application (D3)

### M0-15 · `index.html`, `main.tsx`, Vite config & build — closes D3
**Objective** **D3**, the half DEC-5 deferred: an entry point and a build.
**Files** `apps/studio/index.html`, `src/main.tsx`, `vite.config.ts`, `package.json`
**Acceptance**
- `vite` (7.3.6) and `@vitejs/plugin-react` (4.7.0) resolve from the offline store — verified present before the task starts
- `corepack pnpm --filter @questionbank/studio build` produces a `dist/` that is committed to nothing and asserted by a spec: an `index.html`, a hashed JS bundle, no source map in the production build
- `main.tsx` mounts `StudioShell` (M3-39) and does nothing else — no provider tree the app does not yet need
- **The initial bundle is measured and the number is recorded** in the close-out. §9 rule 20's 250KB budget becomes a gate only once a route split exists; M0 records the measurement and does not invent a per-route budget it cannot yet apportion
- `dist/` in `.gitignore`
**Tests** Build: the build succeeds in the test suite and the artifact shape is asserted · Unit: `main.tsx` mounts and unmounts cleanly in jsdom · the bundle-size measurement is written to a file the close-out reads, so the number cannot be quoted from memory

### M0-16 · Navigation over the History API
**Objective** DEC-M0-13 — turn M3-39's typed route table into working navigation without a router.
**Files** `apps/studio/src/shell/use-route.ts`, `use-route.spec.tsx`
**Acceptance**
- Consumes `shell/navigation.ts` unchanged; a destination not in the table cannot be navigated to
- Back and forward work; an unknown path renders the designed not-found state, never a blank shell
- **Focus moves to the main heading on navigation** — M3-39 already asserts this on destination change and the behaviour must survive becoming real
- The header states it is not a router, names **D30**, and names the trigger: the first nested route or the first validated search param
- **No dependency added** — asserted, so this cannot quietly grow into one
**Tests** Component: navigate/back/forward · unknown path renders not-found · focus moves on navigation · the module's import list is empty of runtime dependencies, asserted

### M0-17 · The typed HTTP client — F15's subject
**Objective** §9 rule 15 says "no hand-written API call — everything through the generated client". **There is no generated client**, so the rule has had no subject since M1.
**Files** `packages/contracts/src/client.ts`, `client.spec.ts`, `packages/contracts/package.json`
**Acceptance**
- A thin `fetch` wrapper typed **from the existing generated artifacts** — `src/curriculum.ts` (openapi-typescript) and `src/content-schemas.ts` (generated Zod). It generates no types of its own; a second type source is a second thing to drift
- Responses are parsed through the generated Zod schema at the boundary. **An unexpected shape is an error, not a cast** — the tier boundary is exactly where the category stops validating and starts hoping
- Sends `Authorization: Bearer`, propagates `X-Correlation-Id`, and surfaces the API's problem-details body (`problem-details.ts`) as a typed error rather than a string
- **F15 becomes enforceable:** no `fetch(` or `XMLHttpRequest` outside this module, scanned across `apps/studio` and `packages/`
- No retry, no cache, no TanStack Query — not in the store, and a walking skeleton needs none
**Tests** Unit against a stubbed `fetch`: success parses · a response failing the schema is an error naming the field · a problem-details body becomes a typed error · headers asserted · F15's scan red on a planted `fetch` in a component

### M0-18 · Studio design tokens & F24
**Objective** §9 rule 16 / F24 — no hardcoded colour outside the token layer.
**Files** `apps/studio/src/tokens.ts`, `apps/api/src/fitness/frontend-rules.ts`, + specs
**Acceptance**
- A token module for Studio mirroring `packages/content-renderer/src/tokens.ts`'s shape — **mirrored, not imported**, on the same argument M3-01 records for `Result`
- **F24 scans `apps/studio/src` and `packages/*/src` for colour literals** — hex, `rgb(`, `rgba(`, `hsl(`, and the CSS named-colour list — outside the enumerated token modules. The enumerated list is a closed constant
- The check asserts it scanned a non-zero number of files, so a broken glob cannot pass as compliance
- Existing Studio components migrated to tokens; the diff is mechanical and reviewed as such
**Tests** Unit: a planted `#0b6` in a Studio component fails · each literal form detected · a token module's own literals allowed · the scanned-file count asserted greater than zero

### M0-19 · One surface wired end to end
**Objective** The client-side half of the walking skeleton. **One** surface — that is the definition.
**Files** `apps/studio/src/features/item-browser/` (wiring only), `item-browser-live.spec.tsx`
**Acceptance**
- The item browser's list query goes through M0-17's client to the composed API. **Its filters keep living in the URL** (M3-43), and that behaviour is asserted after the wiring, not assumed to survive it
- Loading, empty and error states all render; the error state shows the problem-details title, never a raw message and never SQL — **D28** is still open and this is the surface where it would surface
- The remaining Studio features stay on their existing in-memory models, **and a comment in each says so** rather than leaving the next reader to discover which are live
- **New debt D29 recorded:** the Item Editor's commands are not wired, and that is what stands between here and M3's ≤ 20 min criterion (DEC-M0-12)
**Tests** Component against a stubbed client: list renders, empty renders, error renders with a safe message · URL filters round-trip after wiring · Integration: the browser's query executes against the composed application and returns a draft the seed created

---

## Track D — Authored infrastructure

*Tier 2 throughout (DEC-M0-1). Every assertion here is over a file's parsed content. **None of it claims a
runtime property**, and each task names the Tier-3 command that would upgrade it.*

### M0-20 · Compose stack & the spec that parses it
**Objective** ROADMAP's first deliverable, at the only tier this machine supports (DEC-M0-9).
**Files** `infra/compose/docker-compose.yml`, `infra/compose/.env.example`, `apps/api/src/fitness/compose-rules.ts`, `compose-rules.spec.ts` · **plus `docs/adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md`** and the **ADR-0004 amendment**
**Acceptance**
- Services exactly: `postgres`, `valkey`, `minio`, `ai-fixture`, `api`, `studio` — asserted by **set equality** against a closed constant
- Every service declares `healthcheck` with `test`, `interval`, `timeout`, `retries`, `start_period`
- **Every `depends_on` uses the `{ condition: service_healthy }` map form**; the bare list form is a violation
- Images pinned by tag per TECH-STACK §14; **no `latest`**
- No duplicate host port; `postgres` publishes 5432 (DEC-M0-8); the graph is acyclic
- `ai-fixture` replays recorded responses so **the stack needs no API key** (TECH-STACK §8), asserted by the absence of any key-shaped variable in the service's environment
- **ADR-0013** written: the three tiers, the three binding rules, and the instruction to future milestones to cite it rather than reinvent the question
- **ADR-0004 amended in place** per DEC-M0-4 — Compose exists, defaults unchanged, **F8 still failed-blocked**, the named verification still outstanding
- The spec's header names the Tier-3 successor: `docker compose -f infra/compose/docker-compose.yml up --wait`, and states that **no boot time is claimed by this repository**
**Tests** Unit: each assertion above · **planted mutations, one per assertion** — a bare `depends_on` list, a `latest` tag, a duplicate host port, a missing `start_period`, an added service — each shown red · the parse asserts a non-zero service count

### M0-21 · CI workflow & the spec that parses it
**Objective** DEC-M0-3 — the workflow as a thin caller whose thinness is enforced.
**Files** `.github/workflows/ci.yml`, `apps/api/src/fitness/ci-rules.ts`, `ci-rules.spec.ts`
**Acceptance**
- Jobs: `typecheck`, `unit`, `integration`, `fitness`, `build`. Integration runs against a `postgres:16` service container; **`--workspace-concurrency=1` is preserved**, because the integration suites reshape one shared schema and CI is exactly where that gets forgotten
- **Every workspace project is covered by at least one job**, asserted against `pnpm-workspace.yaml`'s globs — a fifth project that no job runs fails here
- `corepack pnpm install --frozen-lockfile`
- **No job carries `continue-on-error`; no job is behind an `if:` that could skip a gate; no `run:` step contains an assertion of its own** (no `grep … && exit 1`, no `test -f`). The gates live in `apps/api/src/fitness/` and CI calls them
- The fitness script is invoked by name — `corepack pnpm --filter @questionbank/api fitness`
- Node version matches `engines.node`, asserted against the root `package.json` rather than duplicated as a literal
**Tests** Unit: each assertion above · planted: `continue-on-error: true`; an inline `grep` gate; a dropped project; a Node version diverging from `engines`; a removed `--workspace-concurrency=1` — each shown red · **the spec states it has never been executed by a CI provider**

### M0-22 · Terraform for staging & the scan it can honestly carry
**Objective** ROADMAP's fourth deliverable, at Tier 2 with a weaker instrument, honestly labelled (DEC-M0-11).
**Files** `infra/terraform/staging/{main,variables,outputs}.tf`, `staging.tfvars.example`, `apps/api/src/fitness/terraform-rules.ts`, + spec
**Acceptance**
- One deployable: the API on ECS Fargate, RDS PostgreSQL 16, security groups, ECR repository, and the secret references — **no secret values**
- Scanned and asserted: every resource carries `Environment = "staging"`; no access key, secret or connection string literal (shares M0-23's scanner); `region` is a variable defaulting to `ap-south-1` (TECH-STACK §10); `aws_db_instance.engine` is `"postgres"` and never an Aurora engine — TECH-STACK §3 calls moving *off* Aurora the one-way door, and the check is where that stays true; a non-local state backend is declared
- **The spec's header states in its first line that this is a lint and not a validation**, and that no HCL parser and no provider plugin is available offline
- Tier-3 successor named verbatim: `terraform init && terraform validate && terraform plan -var-file=staging.tfvars`
**Tests** Unit: each assertion · planted: an untagged resource, a literal secret, a hardcoded region, an Aurora engine, a local backend — each shown red · the scan asserts a non-zero file count

### M0-23 · Secrets discipline & F39
**Objective** F39 — no secret in source, image, or committed config — across everything the previous three tasks just added.
**Files** `apps/api/src/fitness/secret-rules.ts`, `secret-rules.spec.ts`, `apps/api/src/fitness-fixtures/as-committed-secret/`, `.env.example`
**Acceptance**
- Scans the whole tree — source, `infra/compose/`, `infra/terraform/`, `.github/workflows/`, `*.example` — for AWS-shaped keys, PEM headers, `password=`/`secret=`/`token=` with a non-placeholder value, and high-entropy string literals over a documented threshold
- **`.env.example` carries every key the typed config module names, with placeholder values only**, and a spec asserts the two lists are equal — a config key with no documented example is a key the next developer discovers from a stack trace
- The allowlist of known-safe matches is a closed constant with a reason per entry, not a regex that quietly grew
- Asserts a non-zero scanned-file count
**Tests** Unit: each pattern detected on its planted fixture · the config-key/`.env.example` equality, red in both directions · a placeholder value is not a violation · a real-shaped key in a `*.example` file **is** a violation

---

## Track E — Gates and close-out

### M0-24 · The `questionbank_app` role & F7/F40 — closes D9
**Objective** **D9**. `content-rules.integration.spec.ts:84` currently asserts *the deployment role does not exist here*, so F7/F40 has never been exercised against a real app role.
**Files** `infra/migrations/2026…_app_role.sql`, `apps/api/src/fitness/content-rules.integration.spec.ts` (rewritten), `platform-rules.integration.spec.ts`
**Acceptance**
- An idempotent migration creates `questionbank_app` (`DO $$ … IF NOT EXISTS`), **`NOLOGIN` locally with no password in source** (F39); the deployed credential comes from Secrets Manager and the migration never sets one
- Grants: `SELECT`/`INSERT` broadly; `UPDATE`/`DELETE` on draft-bearing tables where M3-20 already establishes drafts need them; **no `UPDATE`, `DELETE` or `TRUNCATE` on any append-only or published-version table**, including `platform.audit_record` from M0-07
- **The "reports honestly that the deployment role is absent" test is rewritten, not deleted** — it now asserts the role exists and holds exactly the expected privilege set, computed against a closed table list. Leaving a test asserting a falsehood is worse than having no test
- The privilege assertion is by set equality against the catalogue, so a grant added by a later migration fails here
- Runs as superuser locally; the task records that the deploying role in staging needs `CREATEROLE`, which is a Terraform/runbook fact and not a code one
**Tests** Integration: the role exists · the privilege set matches exactly · a granted `UPDATE` on `item_version` inside a rolled-back transaction makes the check fire — **the first time F7/F40 has ever fired against a real role** · the same for `platform.audit_record`

### M0-25 · F26 and the attempt engine that does not exist
**Objective** ROADMAP M0 lists F26. `packages/attempt-engine/` does not exist and will not until M6, so the honest options are "blocked" or "a gate that catches the package the day it appears". This is the second.
**Files** `apps/api/src/fitness/frontend-rules.ts`, `apps/api/src/fitness-fixtures/as-attempt-engine/`, + spec
**Acceptance**
- The rule is implemented as a scan over a **named package list** — today `packages/attempt-engine` — asserting zero framework imports (`react`, `react-dom`, `@nestjs/*`, any DOM global)
- **Its subject does not exist, and the check says so out loud**: a spec asserts the package is absent *and* fails loudly if the directory appears without being confirmed in the list. A gate that goes green over an empty set is B1's failure mode and this milestone is where that pattern stops being repeated by accident
- The planted fixture under `fitness-fixtures/as-attempt-engine/` contains a React import and is shown red, so the rule itself is proven working before it has a real subject
- Recorded in the close-out as **`Pass (rule proven) / no subject`** — not as a plain pass
**Tests** Unit: the fixture fails the rule · the absence assertion holds · a planted real `packages/attempt-engine/` not in the list fails the check

### M0-26 · The M0 gate module, planted fixtures & thresholds
**Objective** Every gate M0 adds, each proven with a planted violation — the M1/M2/M3 standard.
**Files** `apps/api/src/fitness/platform-rules.ts`, `platform-rules.spec.ts`, `apps/api/vitest.config.ts`, `apps/studio/vitest.config.ts`, fixtures under `src/fitness-fixtures/`
**Acceptance** — the gate register, each with the violation that proves it can fail:

| Gate | Asserted | Planted violation |
|---|---|---|
| **F7 / F40** | `questionbank_app` holds no `UPDATE`/`DELETE`/`TRUNCATE` on append-only or published-version tables, **against a role that now exists** (M0-24) | `GRANT UPDATE ON content.item_version TO questionbank_app` in a rolled-back transaction |
| **F8** | — | **None. `Fail — blocked`** — no container runtime. No check is written, because a check that cannot run is not a gate |
| **F11** | Every handler in the **composed application** declares a policy; `createApplication` rejects otherwise | A fixture handler with `policy` absent, registered into the real factory |
| **F16** | `process.env` read only in the three enumerated files | A `process.env.DATABASE_URL` read inside a content handler |
| **F24** | No colour literal outside the enumerated token modules | `#0b6` in a Studio component |
| **F26** | Named packages import no framework | A React import in `fitness-fixtures/as-attempt-engine/` (M0-25) |
| **F39** | No secret in source, config, workflow or HCL | An AWS-shaped key and a PEM header in `fitness-fixtures/as-committed-secret/` |
| **F15** | No `fetch`/`XMLHttpRequest` outside the generated client | A `fetch('/v1/items')` in a Studio component |
| **F1 (extended)** | `platform/composition/` reaches contexts only through `public/` | An import of `contexts/content/infrastructure/item.repository.js` from the root |
| **F12 (shared rule)** | No PII in a log record or a span attribute | The M0-03 PII fixture routed through `JsonTelemetry` |

- **F1, F2, F5, F6/F35, F9, F20, F36, F45–F48 and the whole M1/M2/M3 set re-run green — not assumed.** M0 adds a directory the scanners have never seen and a package (`react`) the API has never depended on; both are exactly the kind of change that quietly moves a scan's boundary
- **Coverage thresholds under ADR-0008** for the correctness-bearing platform modules — `auth/token.ts` (who is who), `config/config.ts` (what a secret is), `observability/serializer.ts` (what leaks), `composition/app-factory.ts` (what boots), `persistence/idempotency-store.ts` (what runs twice) — each at 100%, and **each verified failing before it passes**
- `platform-rules.spec.ts` polices its own list, as `content-rules.spec.ts` does: it fails if an in-scope module has no threshold, if a threshold is below 100, or if a named module was deleted without the list being updated
**Tests** Every row green on the real tree and red on its fixture · thresholds asserted present · the full prior fitness set re-run

### M0-27 · Day One verified, ADRs, traceability & close-out
**Objective** Handbook §11 currently opens with `docker compose up`, which nobody in this repository's history has run. Make the document true.
**Files** `docs/ENGINEERING-HANDBOOK.md` §11, `docs/tasks/M0-TRACEABILITY.md`, `docs/tasks/M0-CLOSEOUT.md`, `docs/HANDOFF-M4.md`, `docs/adr/ADR-0012-…`
**Acceptance**
- §11 rewritten as **two paths, both honest**: the supported path today (Homebrew Postgres on 5433, `corepack pnpm install --offline`, export `DATABASE_URL`, `corepack pnpm -r test`, `corepack pnpm --filter @questionbank/api start`), and the Compose path marked **unverified** with ADR-0004's outstanding verification named. §11's closing line — *if step 1 does not work, that is the first bug* — only means something if step 1 is a step someone has taken
- **A spec asserts every command quoted in §11 exists**: each `pnpm` script named is a real script in a real `package.json`, each file path referenced exists. Documentation drift is the one kind this repository has no gate for, and §11 is where it costs the most
- **ADR-0012** (Learn deferred to M6) written; ADR-0011, 0013, 0014, 0015 confirmed merged; **ADR-0004's amendment** in place
- `M0-TRACEABILITY.md` maps every acceptance criterion to the test that proves it, with a **Findings table** marking every partially-proven and blocked criterion — M3's format
- `M0-CLOSEOUT.md` carries the DoD verdict below verbatim, the four ROADMAP criteria with their honest statuses, the new debt (**D29–D32**), the debt closed (**D3, D9, D22, D27**), and DEC-M0-12's four-row table of what M0 did and did not unblock
- `HANDOFF-M4.md` superseded by a new handoff naming M4 as next and stating which of its blockers M0 cleared
- **B1 restated** — see below
**Tests** Unit: the §11 command-existence spec, red on a planted reference to a script that does not exist · the traceability document's criterion list asserted equal to this document's, so a criterion cannot be quietly dropped between the two

---

## Sequencing

```
Week 1   A01→A06 (workspace, config, logging, telemetry, auth)   ║ C15, C16 (entry, build, nav)  ║ DEC ratification
Week 2   B07→B14 (adapters, seam, root, main, skeleton)          ║ C17→C19 (client, tokens, wire) ║ E24 (app role)
Week 3   D20→D23 (compose, CI, terraform, secrets)               ║ E25, E26 (gates)               ║ E27 (Day One, close-out)
```

**Critical path:** A02 → A05 → A06 → B07 → B11 → B12 → B13 → **B14** (~9 days). Everything else hangs off
the composition root, and B14 is the milestone in one test.

**Second path:** C15 → C17 → C19 (~5 days), gated on B14 for its integration half. **Start C15 in week 1**
— it depends on nothing, it closes half of D3 on its own, and if the offline Vite build turns out not to
work, that is a fact worth having on day two rather than day eleven.

**Start B09 early enough to fail early.** `corepack pnpm install --offline` adding `react` to `apps/api` is
the single riskiest assumption in this breakdown. M0-01 verifies the install works before anything depends
on it; if it does not, **D27 stays open and M0 says so** rather than inventing a worker process to hold a
React render.

**Blocked, and known before we start:** F8, the Grafana trace, the staging deploy, and CI actually running.
None of them is on the critical path, because none of them is achievable at any point along it.

---

## Milestone Definition of Done

A task is done when merged with tests green. **The milestone** is done when all of the following hold.
**Five lines are marked blocked before work begins**, because their blockers are known now and pretending
otherwise for three weeks helps nobody.

**Delivered and proven here (Tier 1)**

- [ ] All 27 tasks merged
- [ ] **`corepack pnpm --filter @questionbank/api start` serves an authenticated request** through the composed application to real Postgres and back, with the answer key absent from the delivery payload
- [ ] **`createApplication` rejects on a handler with no authorization policy** (F11), proven against a planted violation across the whole composed handler population — the first time the full set has been in one place
- [ ] **`RenderValidator` has a production adapter and the publication precondition runs against it** — **D27 closed**, and `application/ports.ts`'s D27 comment rewritten to describe what exists
- [ ] **The idempotency store is durable and survives a restart** — **D22 closed**; concurrent duplicates resolve to one execution, proven with overlapping transactions
- [ ] **`questionbank_app` exists locally and F7/F40 fires against it** — **D9 closed**; the "role is absent" test rewritten, not deleted
- [ ] **Studio builds, mounts and navigates; one surface talks to the API through the typed client** — **D3 closed**; the initial bundle size measured and recorded, not estimated
- [ ] F15 has a subject for the first time: no `fetch` outside the generated client
- [ ] Every configuration value is read through the typed config module (F16); `.env.example` and the config key set are asserted equal
- [ ] No secret in source, config, workflow or HCL (F39); no PII in any log record or span attribute
- [ ] One request emits one connected span tree carrying the response's correlation id end to end
- [ ] **Handbook §11 describes a path someone has actually taken**, and a spec asserts every command it names exists
- [ ] **F1, F2, F5, F6/F35, F9, F20, F36, F45–F48 still green** — re-run, not assumed, after `platform/` and `react` enter the tree
- [ ] 100% coverage on `auth/token.ts`, `config/config.ts`, `observability/serializer.ts`, `composition/app-factory.ts`, `persistence/idempotency-store.ts`, each verified failing first; ≥ 80% line / ≥ 70% branch overall

**Authored and asserted, claiming nothing more (Tier 2)**

- [ ] The Compose file declares six services, a health check on every one, `service_healthy` on every dependency, pinned images and no port collision — **every assertion proven red on a planted mutation.** No boot, no boot time, and no claim of either
- [ ] The CI workflow declares five jobs covering every workspace project, with no `continue-on-error`, no conditional gate and **no assertion of its own** — the gates stay in `apps/api/src/fitness/`
- [ ] Terraform for one staging deployable, **linted and labelled a lint**, with the Tier-3 command recorded verbatim
- [ ] ADR-0011, ADR-0012, ADR-0013, ADR-0014, ADR-0015 merged; **ADR-0004 amended in place**, still recording F8 as failed-blocked

**Blocked — marked so now, and not to be narrowed until they pass (Tier 3)**

- [ ] **`docker compose up` → full stack healthy in ≤ 10 min** — **`Fail — blocked`**: no container runtime on this machine (ADR-0004). **F8 is not claimed and no check for it is written.** Nearest evidence: the parsed service graph. Successor: `docker compose -f infra/compose/docker-compose.yml up --wait`
- [ ] **One request traced client → API → database in Grafana** — **`Fail — blocked`** on two independent resources: no `@opentelemetry/*` in the offline store (**D31**), and no Grafana account. Nearest evidence: the in-process span tree above, which is not a trace in a backend and is not reported as one
- [ ] **Staging deploy from a green main in ≤ 15 min** — **`Fail — blocked`**: no cloud account, no network, no CI runner. **Nearest evidence: none.** A Terraform lint is not evidence of a deploy and is not offered as one
- [ ] **CI gates blocking** — **`Fail — blocked`**: no CI provider connected. The workflow is authored and its gate set asserted; it has never been executed
- [ ] **Every listed fitness function fails a planted violation** — **Partial: 9 of 10.** F1, F2, F5, F7, F11, F16, F24, F26, F39 each proven red on a planted violation; **F26 additionally reported as `rule proven / no subject`** because `packages/attempt-engine` does not exist. **F8 not claimed.** This is the one ROADMAP acceptance criterion M0 substantially meets, and it is reported as partial rather than as met

**Carried and reassigned**

- [ ] **"An author produces a stimulus-linked set in ≤ 20 min"** — moves from `Fail — blocked on D3/M0` to **`Fail — blocked on D29`**, the unwired Item Editor. The blocker shrinks from a milestone to a task, and the close-out says exactly that rather than implying it passed
- [ ] **"40 items/hour reviewing"** — **`Fail — blocked`, blocker reassigned from M0 to M4.** There is no review workspace to time. **M4 must not read M0's landing as permission to claim this**
- [ ] **D2 (Playwright E2E) still deferred** — Playwright is not in the offline store. Unchanged by M0
- [ ] **D10 (browser-measured p95) still deferred**, blocker renamed: a real application in a real browser now exists; a measurement harness does not
- [ ] New debt recorded: **D29** (Item Editor unwired), **D30** (navigation is not a router), **D31** (no OTLP exporter), **D32** (no S3 `MediaStore` adapter) — each with a named trigger
- [ ] **B1 carried forward and restated** — M2-30, the golden set validated against zero real papers, remains blocked on [DECISIONS §D item 2](../DECISIONS.md) and legal counsel sign-off. **Do not attempt to source papers.** It appears in the M0 close-out and in every handoff until it closes

---
