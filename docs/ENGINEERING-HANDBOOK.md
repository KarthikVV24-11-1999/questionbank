# Engineering Handbook
**Version:** 1.0 · **Date:** 2026-08-05
**Audience:** every engineer, from day one · **Status:** binding

> Rules, not rationale. The reasoning lives in the phase documents; this is what you do.

---

## 1. Folder Structure

```
questionbank/
├── apps/
│   ├── learn/              # Student PWA          (React + Vite)
│   ├── studio/             # Authoring & ops SPA  (React + Vite, desktop-only)
│   ├── site/               # Marketing            (SSG)
│   ├── api/                # Core API             (NestJS)
│   ├── workers/            # Async workers        (TypeScript)
│   ├── relay/              # Outbox relay         (TypeScript)
│   ├── ai/                 # AI Service           (Python + FastAPI)
│   └── psychometrics/      # Batch statistics     (Python)
├── packages/
│   ├── contracts/          # Generated OpenAPI types + Zod schemas
│   ├── design-system/      # L1 primitives + design tokens
│   ├── content-renderer/   # L2 — the single ContentRenderer
│   ├── attempt-engine/     # Offline engine, zero framework imports
│   ├── domain-types/       # Shared kernel only: PrincipalRef, UserId, RoleSet
│   └── config/             # eslint, tsconfig, tailwind presets
├── infra/
│   ├── terraform/
│   ├── compose/
│   └── migrations/
├── tools/
│   ├── fitness/            # Fitness-function checks run in CI
│   └── seed/               # Local development data
└── docs/
    ├── adr/                # Architecture Decision Records
    └── *.md                # Phase documents
```

### `apps/api/src/`

```
src/
├── contexts/               # One directory per bounded context, named identically
│   ├── identity/  curriculum/  content/  assessment/  scoring/
│   ├── psychometrics/  learning/  commerce/  engagement/  trust/  search/
└── platform/               # Infrastructure only — never domain logic
    ├── http/  persistence/  messaging/  observability/  config/  auth/
```

### Inside every context — fixed anatomy, no exceptions

```
contexts/content/
├── api/              # Controllers, DTOs. No business logic.
├── application/      # Command + query handlers. Orchestration only.
├── domain/           # Aggregates, value objects, policies, events.
│                     #   ← depends on NOTHING. No imports from anywhere.
├── infrastructure/   # Repositories, adapters. Depends inward only.
└── public/           # The barrel. Exports exactly three things:
                      #   commands, queries, events.
```

**Rules**
- A module imports from another module **only** through its `public/` barrel.
- `domain/` imports nothing — not the ORM, not the framework, not another context.
- `platform/` contains zero business logic. A rule in `platform/` is a rule in the wrong place.
- Adding a top-level directory requires an ADR.

---

## 2. Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Directories | `kebab-case` | `review-workspace/` |
| TypeScript files | `kebab-case.ts` | `publish-item.handler.ts` |
| Python files | `snake_case.py` | `generation_run.py` |
| Classes, types | `PascalCase` | `ItemVersion`, `NumericAnswerSpec` |
| **Aggregates** | The domain noun **exactly** | `Item` — never `ItemEntity`, `ItemModel` |
| **Commands** | Imperative verb phrase | `PublishItem` → `PublishItemHandler` |
| **Queries** | `Get*` / `List*` | `GetItemById`, `ListReviewQueue` |
| **Domain events** | Past tense | `ItemPublished`, `AttemptSubmitted` |
| React components | `PascalCase.tsx` | `QuestionPalette.tsx` |
| React hooks | `use*` | `useAttemptTimer` |
| DB tables | `snake_case`, **singular** | `item_version`, not `item_versions` |
| DB columns | `snake_case` | `current_published_version_id` |
| Foreign keys | `<table>_id` | `item_version_id` |
| Timestamps | `*_at` | `published_at`, `deleted_at` |
| Booleans | `is_*` / `has_*` | `is_current`, `has_solution` |
| DB enum values | `snake_case` | `changes_requested` |
| API paths | Plural, `kebab-case` | `/v1/exam-profiles/{id}` |
| API JSON fields | `camelCase` | `itemVersionId` |
| Analytics events | `domain.object_past_verb` | `mock.attempt_submitted` |
| Feature flags | `<context>.<flag>` | `learning.spaced_repetition` |
| Migrations | `<timestamp>_<description>` | `20260812_add_item_locale.sql` |
| Unit tests | `*.spec.ts` / `test_*.py` | `scoring-rule.spec.ts` |
| E2E tests | `*.e2e.ts` | `mock-attempt.e2e.ts` |

**Casing boundary:** the database is `snake_case`, the API is `camelCase`, and the mapping happens once — in the repository layer. Nowhere else.

**Never** name anything `util`, `helper`, `common`, `misc`, `manager`, or `service` without a qualifier. If you cannot name it precisely, you have not decided what it is.

---

## 3. Git Workflow & Branch Strategy

**Trunk-based. `main` is always deployable.**

| Rule | |
|---|---|
| Branch from `main`, merge to `main` | No `develop`, no release branches |
| Branch lifetime | **≤ 3 days.** Longer means the change is too big |
| Direct push to `main` | Prohibited — branch protection |
| Merge strategy | **Squash.** One PR, one commit on `main` |
| PR size | ≤ 400 changed lines. Bigger needs a stated reason |
| PR scope | One concern. "And also" in a description means two PRs |
| Required to merge | Green CI + one approval; two for scoring, auth, or migrations |
| Releases | Tag on `main`; deploy from `main` |

**Branch names:** `<type>/<short-description>` — `feat/item-versioning`, `fix/sync-watermark`, `chore/bump-drizzle`

**Long-running work** goes behind a feature flag on `main`, never on a long-lived branch. Flags are removed within 90 days of full rollout.

---

## 4. Commit Conventions

**Conventional Commits.** `<type>(<scope>): <subject>`

```
feat(content): add locale variants to item version
fix(assessment): preserve response log across device switch
refactor(scoring): extract rule executor from score service
```

| Type | Use for |
|---|---|
| `feat` | New capability |
| `fix` | Defect repair |
| `refactor` | Behaviour-preserving change |
| `perf` | Measured performance change |
| `test` | Tests only |
| `docs` | Documentation only |
| `build` / `ci` | Tooling |
| `chore` | Dependencies, config |

**Scope is the bounded context** — `content`, `assessment`, `scoring`, `learning`, `commerce`… or the app/package name.

**Rules**
- Subject: imperative mood, lowercase, no trailing period, ≤ 72 chars.
- Body explains **why**, never what — the diff already shows what.
- Breaking change: `feat(api)!:` plus a `BREAKING CHANGE:` footer.
- **Any commit touching scoring rules, marking logic, or `NumericAnswerSpec` must state the golden-set result in the body.**
- Reference the issue in the footer, never the subject.

---

## 5. Testing Strategy

| Layer | Tool | What belongs here |
|---|---|---|
| **Unit** | Vitest / pytest | Domain logic, scoring rules, the Attempt Engine, formatters. No I/O. |
| **Integration** | Vitest + real Postgres via Compose | Repositories, handlers, migrations. Never mock the database. |
| **Component** | Testing Library | Rendering and interaction. Query by role, never by test-id. |
| **Contract** | OpenAPI + consumer tests | Every public endpoint |
| **E2E** | Playwright | The critical journeys only — not a second unit suite |
| **Adversarial** | Playwright + network shaping | Network loss, process kill, device switch, clock skew |

### Mandatory coverage

| Surface | Requirement |
|---|---|
| Scoring, marking, entitlement | **100% branch** |
| Authorization negative paths (T0/T1) | **100%** |
| Overall | ≥ 80% line, ≥ 70% branch |

### Blocking suites

| Suite | Frequency |
|---|---|
| **Golden-set scoring regression** | Every commit |
| Performance budgets | Every commit |
| Answer-key payload inspection | Every release |
| **Adversarial network + process-kill** | Every release |
| Accessibility (automated) | Every release |
| Fitness functions | Every commit |

**Rules**
- A bug fix ships with the test that would have caught it. No exception.
- Test names describe behaviour: `rejects submission when idempotency key is reused`.
- Never mock what you own. Mock only third parties, and prefer a fixture.
- Flaky test = broken test. Quarantine within 24 h, fix within a week, never re-run to green.
- The Attempt Engine is tested without a DOM. If it needs one, it has been contaminated.
- **Every architectural rule is proven able to fail.** A fitness function ships alongside a committed
  violation it is shown to catch — see `apps/api/src/fitness-fixtures/`. A gate that has only ever been
  run against a clean tree has not been shown to work; it has been shown to agree with itself.
- **Where one rule must exist in two places, a test asserts the two agree** — over the whole surface,
  never a sample. Two implementations of one rule drift, and the drift is silent until something
  downstream is already wrong. This has cost this project three separate defects.
- **A test asserts a condition, never a duration.** Wait for the thing to become true; do not sleep for
  however long it took once on the machine you happened to write it on.

---

## 6. Documentation Standards

| Artifact | Rule |
|---|---|
| **ADR** | Every architectural decision. Numbered, dated, immutable once accepted. |
| **Phase docs** (`docs/*.md`) | The design record. Updated when a decision changes, never silently. |
| **README** per app/package | What it is · how to run · how to test. Three sections, nothing more. |
| **API documentation** | The OpenAPI spec. There is no second API doc to fall out of sync. |
| **Code comments** | Only for constraints the code cannot express. |

**ADR template**
```
# ADR-0042 — Short decision title
Status: Proposed | Accepted | Superseded by ADR-00xx
Date: 2026-08-05

## Context      — what forces this decision, and what constraints apply
## Decision     — what we are doing, in one paragraph
## Consequences — what this makes easy, what it makes hard, what it forecloses
## Alternatives — what was rejected and why
```

**Superseding an ADR creates a new one.** Accepted ADRs are never edited — the record of what we believed and when is the point.

**Comment rules**
- Write a comment for a constraint the reader cannot derive: *"Ordered by exposure ascending — form assembly depends on this."*
- Never write a comment that narrates the next line, records where code came from, or justifies your change to a reviewer. That belongs in the PR.
- A comment explaining *what* the code does means the code needs renaming.

---

## 7. Logging Standards

| Rule | |
|---|---|
| Format | Structured JSON, one event per line |
| Correlation | `correlation_id` from the gateway, `causation_id` propagated **through queue messages into workers** |
| **PII** | **Zero.** Enforced by a serializer allowlist, never a redaction regex |
| What you log | Identifiers — `item_version_id`, never item content |
| `error` | Actionable. Someone must be able to do something |
| `warn` | Degradation the system absorbed |
| `info` | State transitions only. Not one per request |
| `debug` | Off in production |
| Audit vs. application logs | **Separate systems.** Never conflate |

**Never log:** names, emails, phone numbers, credentials, tokens, payment data, item content, answer keys, or any raw request body.

---

## 8. Error Handling

| Rule | |
|---|---|
| Domain and application layers | Return typed results. Do not throw. |
| Throwing | Infrastructure faults only — the database is unreachable, the network failed |
| Error taxonomy | Fixed, closed set (below). Adding one is an API change |
| Response format | RFC 9457 Problem Details with a stable machine-readable `code` |
| `retryable` flag | Explicit on every error response. Clients must not infer it |
| Correlation ID | Returned in every error response |
| Never in a response | Stack traces, internal identifiers, dependency names, SQL |

**The taxonomy**

`Validation` · `Authentication` · `Authorization` · `Entitlement` · `NotFound` · `Conflict` · `PreconditionFailed` · `RuleViolation` · `RateLimited` · `Unavailable`

**`Entitlement` is distinct from `Authorization`.** "Upgrade to access" and "you are not permitted" need different UX and different metrics.

**Fail closed** on authorization, entitlement, and scoring.
**Fail open** on recommendations, AI enrichment, and analytics.

An unhandled worker error goes to the DLQ with an alarm. Never a silent drop, never a bare catch.

---

## 9. Architecture Rules

These are enforced in CI. Violating one fails the build.

| # | Rule |
|---|---|
| 1 | Cross-module imports go through `public/` barrels only |
| 2 | `domain/` imports nothing |
| 3 | No cross-schema foreign keys |
| 4 | Cross-context state change happens via domain events, never a direct command |
| 5 | The shared kernel is exactly three types |
| 6 | Every command/query handler declares an authorization policy — boot fails otherwise |
| 7 | Every JSONB column has a sibling `*_schema_version` |
| 8 | No secondary index on `response_event` without an ADR |
| 9 | No synchronous third-party call reachable from a T0 route |
| 10 | Answer keys and solutions absent from every client payload |
| 11 | Append-only tables hold no UPDATE/DELETE grant for the app role |
| 12 | No PII pattern in any log, trace, or metric |
| 13 | `ContentRenderer` has exactly one implementation |
| 14 | The Attempt Engine has zero framework imports |
| 15 | No hand-written API call — everything through the generated client |
| 16 | No hardcoded colour outside the token layer |
| 17 | No configuration read outside the typed config module |
| 18 | Feature flags may not alter scoring rules or content governance |
| 19 | Full Compose stack boots in ≤ 10 minutes |
| 20 | No route exceeds its bundle budget |

Full definitions: [ARCHITECTURE.md](ARCHITECTURE.md) §14, [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) §16, [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) §16, [AI-ARCHITECTURE.md](AI-ARCHITECTURE.md) §18, [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) §14.

---

## 10. Review Checklist

CI already checked formatting, lint, types, coverage, budgets, and fitness functions. **Do not review those.** Review what a machine cannot.

### Correctness
- [ ] Does this change scoring, marking, or tolerance behaviour? If so — golden-set result stated, second approver present.
- [ ] Are new invariants enforced structurally, or only by convention?
- [ ] Is every error path handled, and does it fail in the correct direction?
- [ ] Does the failure mode degrade or corrupt?

### Domain
- [ ] Is this in the right bounded context?
- [ ] Does it mutate exactly one aggregate per transaction?
- [ ] Are cross-context effects events, not calls?
- [ ] Does the code use domain language, or has it invented a synonym?

### Data
- [ ] Is the migration backward-compatible and reversible?
- [ ] Does a new column belong on a hot table, or somewhere colder?
- [ ] Does a new query have an index, and is that index justified?
- [ ] Is anything appended to a write-hot path?

### Security & privacy
- [ ] Is there an authorization policy, and is the negative path tested?
- [ ] Could this expose an answer key, a solution, or PII?
- [ ] Is new user input validated at the boundary?
- [ ] Does anything new reach a log, a URL, or telemetry?

### Correctness of experience
- [ ] Does this work offline, or is that irrelevant here?
- [ ] Does it work on the minimum device profile?
- [ ] Is it keyboard-operable and screen-reader-labelled?
- [ ] What does the empty state look like? The error state?

### Operability
- [ ] Can I tell from logs and metrics that this is working?
- [ ] What alerts when it breaks, and is there a runbook?
- [ ] What does this cost per thousand users?

### Craft
- [ ] Does this read like the code around it?
- [ ] Is there a simpler version?
- [ ] Would a new engineer understand it in six months?

**Reviewer conduct**
- Distinguish **blocking** from **suggestion**. Say which.
- Ask questions rather than issuing verdicts when you might be wrong.
- Approve with comments when nothing blocks — do not hold a PR for taste.
- Review within one business day. A stale PR is a merge conflict accruing interest.
- Style opinions are the linter's job. If you find yourself arguing style, change the linter instead.

---

## 11. Day One

Two paths. **The first is the one someone has actually taken** — every command below was run for real
while M0-27 wrote this section, not copied from a plan. The second is authored and has never been
booted; ADR-0004 names exactly what verifying it requires.

### The supported path (verified, M0-27)

1. `git clone && corepack pnpm install --offline` (or, on a machine with network, drop `--offline`) —
   installs from the workspace's own lockfile, no Docker required
2. Homebrew Postgres on port 5433 (`~/.questionbank-pg`, ADR-0004); export
   `DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"` (and `questionbank_test` for the test
   database)
3. `corepack pnpm -r --workspace-concurrency=1 test` — everything green
4. `corepack pnpm --filter @questionbank/seed run seed` — demo exam profile, taxonomy, sample items, against
   the same database
5. `corepack pnpm --filter @questionbank/api start` — boots the composed application for real. Verified this
   session: `/healthz` and `/readyz` both 200, an authenticated `GET /v1/exams` returns `200 []` against a
   freshly migrated database with the `X-Correlation-Id` response header present. `start` runs `vite-node
   src/main.ts` — there is no build step for `apps/api` in this repository, and `vite-node` is the one
   TypeScript-with-decorators runner in the offline dependency store that does not need one
6. Read [DECISIONS.md](DECISIONS.md), then [DOMAIN-MODEL.md](DOMAIN-MODEL.md) §2 (the ten load-bearing
   decisions)
7. Ship something small on day one — a copy fix, a test, a doc correction

If step 3 does not work, that is the first bug and it outranks whatever you were assigned.

### The Compose path — authored, unverified (Tier 2, ADR-0013)

`git clone && pnpm install && docker compose -f infra/compose/docker-compose.yml up --wait`, then `pnpm
seed` and `pnpm test` with `DATABASE_URL` unset (Compose publishes 5432, the documented default). **Nobody
in this repository's history has run this.** `infra/compose/docker-compose.yml` is authored and its service
graph, health checks and dependency order are asserted by parsing it (M0-20); none of that is a boot time,
and F8 (`full stack healthy in ≤ 10 min`) stays `Fail — blocked` until this path has actually been taken
once, on a machine with a container runtime (ADR-0004's own outstanding verification).
