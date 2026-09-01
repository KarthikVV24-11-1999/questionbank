# Question Bank

A content platform for JEE/NEET exam preparation: a governed question bank, a versioned scoring engine, and
the authoring and review tooling that feeds them. It is being built content-pipeline-first — the storefront
and the learner-facing product come later, once there is a corpus worth delivering.

## Current state

- **5 of 11 milestones closed** — the walking skeleton, the curriculum spine, the scoring engine, the
  content model and authoring, and the governance and review workspace. AI generation is next.
- The application boots and serves an authenticated request against real Postgres:
  `corepack pnpm --filter @questionbank/api start`, then an authenticated `GET /v1/exams` — see
  [How to run it](#how-to-run-it) for the full sequence.
- **4,857 tests** across 6 workspace projects. Coverage floors are enforced in the test run — ≥80%
  line/≥70% branch overall, **100% on every correctness-bearing module** (scoring, publication
  preconditions, the answer-key projection, the audit chain).

### Known gaps, stated plainly

These are real and deliberately not papered over:

- **The golden scoring set is validated against zero real exam papers.** Four synthetic fixtures, so the
  regression gate runs on every commit and proves very little. Blocked on a content licensing and IP
  decision that needs legal input, not engineering.
- **No Compose stack has ever booted**, and no cloud deploy exists. Both are authored and checked by
  parsing only — see [ADR-0013](docs/adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) for
  what that does and does not entitle either to claim. CI is the one piece of this that has since been
  executed for real ([ADR-0023](docs/adr/ADR-0023-the-ci-workflow-is-executed-and-leaves-tier-2.md));
  its first red build was two tests that had only ever passed because this machine is fast.
- **Reviewer throughput is `Fail — blocked`.** The review workspace is built and its interaction cost is
  measured, but the ≥ 40 items/hour target needs real reviewers, of which there are none.
- **There is no learner-facing application yet** — by design. Content first.

---

## Architecture

Three bounded contexts today, each under `apps/api/src/contexts/`:

```
apps/studio ──▶ packages/contracts ──▶ apps/api
 (Studio UI)     (typed client,          ├─ contexts/curriculum/  taxonomy, exam profiles — no dependencies
                  generated from         ├─ contexts/scoring/     marking, scoring — mirrors curriculum's
                  OpenAPI)               │                        vocabulary as its own types; does not import it
                                         └─ contexts/content/     items, versions, lifecycle, authoring, review
                                                                   (M4) — imports scoring/public/ for the
                                                                   answer-key projection only
```

| Context | Owns | Depends on |
|---|---|---|
| `curriculum` | Taxonomy, concepts, exam profiles, marking rule sets | nothing |
| `scoring` | The marking executor, score records, rescoring | nothing — mirrors curriculum's vocabulary, asserted equal to it by a spec, never imports it |
| `content` | Items, versions, lifecycle, authoring, review workspace (M4) | `scoring/public/`, for the answer-key projection only |

Cross-context access goes through a context's `public/` barrel and nothing deeper. This is enforced by a
test — [`apps/api/src/fitness/boundary-rules.spec.ts`](apps/api/src/fitness/boundary-rules.spec.ts) — not by
convention: a planted import reaching past a barrel is asserted to fail.

`domain/` in every context is pure: no I/O, no framework, no clock, no randomness.

Six workspace projects: `apps/api` (the backend), `apps/studio` (internal authoring/review frontend),
`packages/content-renderer` (the one renderer authoring and delivery both use), `packages/contracts`
(generated OpenAPI types, Zod schemas, the typed client), `packages/domain-types` (the shared kernel), and
`tools/seed` (deterministic fixture-data loader). See [How to test it](#how-to-test-it) for each one's own
README.

---

## How to run it

Verified on this project's own development machine: macOS, Node ≥ 22, no Docker required for local
development. Not yet verified on a clean install elsewhere — if a step below doesn't work on your machine,
that's real information; please open an issue.

1. **Install Node 22+ and enable Corepack**, then install dependencies from the workspace's own lockfile:

   ```bash
   corepack enable
   corepack pnpm install
   ```

   (Add `--offline` only if you are working from a pre-populated `node_modules/.pnpm` store with no network
   access — that is this project's own development environment, not a requirement of the repository.)

2. **Install PostgreSQL 16** and start it locally. This repository does not yet have a working Docker Compose
   path — `infra/compose/docker-compose.yml` exists and is validated by parsing it, but nobody has booted it
   (see [`docs/adr/ADR-0004`](docs/adr/ADR-0004-local-postgres-pending-m0-compose.md)). Point `DATABASE_URL`
   at whatever Postgres 16 instance you have running; this project's own instance runs via Homebrew on port
   `5433`.

   Create two databases — one for real use, one for the integration test suite:

   ```bash
   createdb -h 127.0.0.1 -p 5433 -U postgres questionbank
   createdb -h 127.0.0.1 -p 5433 -U postgres questionbank_test
   ```

3. **Create the application's database role.** The app connects to Postgres as `questionbank_app`, a
   least-privilege role with no `UPDATE`/`DELETE` grant on append-only or published-version tables (F7/F40).
   The role is cluster-wide, so this runs once regardless of how many databases you create:

   ```bash
   psql -h 127.0.0.1 -p 5433 -U postgres -c "CREATE ROLE questionbank_app NOLOGIN;"
   ```

   (`NOLOGIN` matches this repository's local convention — see
   [`infra/migrations/20260814100000_app_role.sql`](infra/migrations/20260814100000_app_role.sql) for the
   grants a later migration applies to it. A staging or production deployment supplies real login credentials
   through a secrets manager, never through this repository.)

4. **Apply migrations to the `questionbank` database.** There is currently no standalone migration CLI — the
   only runner in the repository is `apps/api/src/testing/database.ts`'s `applyMigrations()`, used by the
   integration test suite and equally usable as a one-off script against any `DATABASE_URL`. `vite-node` only
   runs files, so write one:

   ```bash
   cd apps/api
   cat > /tmp/qb-migrate.mjs <<'EOF'
   import { connectTestDatabase } from './src/testing/database.js';
   const db = await connectTestDatabase();
   await db.applyMigrations();
   await db.close();
   console.log('migrations applied to', process.env.DATABASE_URL);
   EOF
   DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank" corepack pnpm exec vite-node /tmp/qb-migrate.mjs
   rm /tmp/qb-migrate.mjs
   ```

   You do **not** need to run this against `questionbank_test` — the integration test suite applies its own
   migrations automatically, per spec file, the first time it needs them.

5. **Export the configuration the typed config module requires** (`apps/api/src/platform/config/config.ts`;
   the full, current key list lives in [`.env.example`](.env.example)):

   ```bash
   export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"
   export PORT=3000
   export NODE_ENV=development
   export AUTH_SIGNING_KEY="$(openssl rand -hex 32)"
   export AUTH_ISSUER=questionbank
   export AUTH_TOKEN_TTL_SECONDS=3600
   export MEDIA_STORAGE_ROOT=./var/media
   export LOG_LEVEL=info
   ```

6. **Boot the application** — there is no build step for `apps/api`; `start` runs the TypeScript source
   directly through `vite-node`, the one runner in this project's dependency set that handles NestJS
   decorators without a compile step:

   ```bash
   corepack pnpm --filter @questionbank/api start
   ```

7. **Prove it works.** In a second terminal:

   ```bash
   curl -i http://127.0.0.1:3000/healthz   # 200
   curl -i http://127.0.0.1:3000/readyz    # 200, confirms the database connection
   ```

   The auth stub only *verifies* tokens (it never issues identities — see
   [`docs/adr/ADR-0014`](docs/adr/ADR-0014-the-auth-stub-issues-a-principal-not-an-identity.md)), so to reach
   an authenticated route you need a token signed with the same `AUTH_SIGNING_KEY` you exported above. From
   `apps/api`:

   ```bash
   cat > /tmp/qb-issue-token.mjs <<'EOF'
   import { issue } from './src/platform/auth/token.js';
   const now = Math.floor(Date.now() / 1000);
   console.log(issue(
     { sub: 'dev-1', kind: 'human', roles: ['learner'], iat: now, exp: now + 3600, iss: 'questionbank', jti: 'dev-1' },
     { signingKey: process.env.AUTH_SIGNING_KEY, issuer: 'questionbank' },
   ));
   EOF
   corepack pnpm exec vite-node /tmp/qb-issue-token.mjs
   rm /tmp/qb-issue-token.mjs
   ```

   (`roles: ['learner']` matters — `ListExams`'s policy accepts `learner`, `curriculum_curator`,
   `content_ops` and `exam_owner`; an unlisted role gets a `403 Authorization` Problem Details response, not
   a `401`, because the token itself verified fine.)

   ```bash
   curl -i http://127.0.0.1:3000/v1/exams -H "Authorization: Bearer <token from above>"
   # 200 [], with an X-Correlation-Id response header
   ```

   That request — an authenticated call reaching the composed application, real Postgres, and back with a
   correlation id — is the thing this repository calls "the walking skeleton" (M0-14), and every command
   above was run against a freshly created database to write this document.

8. **Optional — seed demo data.** `corepack pnpm --filter @questionbank/seed run seed` loads a demo exam
   profile, taxonomy and sample items into whatever `DATABASE_URL` is exported.

If step 6 does not boot, or step 7 does not return `200`, that is the first bug — see
[`docs/ENGINEERING-HANDBOOK.md`](docs/ENGINEERING-HANDBOOK.md) §11 for the verified reference path this was
derived from, and check that your Postgres role and grants (step 3) match what the migration in
[`infra/migrations/20260814100000_app_role.sql`](infra/migrations/20260814100000_app_role.sql) expects.

---

## How to test it

```bash
corepack pnpm -r typecheck                       # every workspace project, tsc --noEmit
corepack pnpm -r --workspace-concurrency=1 test   # every workspace project's test suite
```

**`--workspace-concurrency=1` is not optional.** The integration suites across `apps/api` and `tools/seed`
share one Postgres schema and reshape it as they run; two projects' integration specs running at once will
corrupt each other's fixtures. Unit specs don't care, but the flag applies to the whole `pnpm -r` invocation.

**Integration specs need a real database.** Export `DATABASE_URL` pointed at `questionbank_test` (or unset
it, and the test harness defaults to `postgres://postgres@127.0.0.1:5432/questionbank_test` — the port
Docker Compose will publish once that path is verified). A spec file's suffix tells you what it needs:
`*.spec.ts` is a pure unit test with no I/O; `*.integration.spec.ts` opens a real connection pool and will
fail immediately, with a clear connection error, if no database is reachable.

**The six workspace projects**, each independently runnable with its own `test`/`typecheck` scripts — see
each project's own README for what it actually contains:

| Project | What it is |
|---|---|
| [`apps/api`](apps/api/README.md) | The NestJS backend: domain contexts, HTTP surface, platform adapters |
| [`apps/studio`](apps/studio/README.md) | The internal authoring/review frontend |
| [`packages/content-renderer`](packages/content-renderer/README.md) | The one `ContentRenderer` implementation shared by authoring preview and student delivery |
| [`packages/contracts`](packages/contracts/README.md) | Generated OpenAPI types, Zod schemas, and the typed HTTP client |
| [`packages/domain-types`](packages/domain-types/README.md) | The shared kernel — types every context may depend on |
| [`tools/seed`](tools/seed/README.md) | The deterministic fixture-data loader |

**`apps/api` also has a `fitness` script** (`corepack pnpm --filter @questionbank/api fitness`) — the
architectural gate suite: boundary rules, coverage thresholds, secret scanning, and every other
correctness-bearing check that is not a unit test of product behaviour. It runs as part of `test`, but it is
worth knowing it exists separately, because it is what CI would call if a CI provider were connected here
(it is not — see the handbook's honest accounting of what actually runs in this environment).

---

## Where to start reading

**[`docs/README.md`](docs/README.md) is the full index** — one line per document, grouped by what question
it answers. In this order, without opening everything:

1. **[`docs/ENGINEERING-HANDBOOK.md`](docs/ENGINEERING-HANDBOOK.md)** — *how is code here supposed to look?*
   The architecture rules (context boundaries, the `public/` barrel convention, the five-directory anatomy),
   the closed error taxonomy, and §11's Day One path, which this README's setup section is an expanded
   version of.
2. **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — *what are the pieces, and how do they compose?* See
   also the [Architecture](#architecture) section above for the current, as-built shape.
3. **The ADRs, under [`docs/adr/`](docs/adr/)** — *why does this specific divergence from the obvious design
   exist?* Each records one decision, its consequences, and the alternatives that were rejected and why. Not
   meant to be read start to finish — consult one when the code does something that looks like it contradicts
   an approved document, because it usually means an ADR explains the gap.

For the product and domain reasoning behind all of the above — what a `ReviewDecision` is, why an answer key
is `unresolved` by default, what "correctness-bearing" means for coverage — see
[`docs/DOMAIN-MODEL.md`](docs/DOMAIN-MODEL.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## How work is done here

**The unit of work is a task**, and a task is done when it is merged with its own tests green — not when the
code compiles, not when it "looks right." Each milestone is broken down before it starts, naming every task's
files, its acceptance criteria, and the tests that prove each criterion; the task is scoped narrowly enough
that "done" is a fact you can check, not a judgement call. Cross-context work goes through a `public/` barrel
only — never by reaching into another context's `domain/` or `infrastructure/` — and that boundary is itself
enforced by a test (`boundary-rules.spec.ts`), not by convention.

**The quality bar is that every claim in this repository is backed by something that can fail.** A test
asserting an aggregate is immutable is worthless if nothing ever mutates it first; a fitness function
asserting no secret is committed is worthless if it has never seen a real secret and turned red. This is why
almost every gate in this codebase — the boundary checker, the secret scanner, every fitness function under
`apps/api/src/fitness/` — ships with a **planted violation**: a fixture that deliberately breaks the rule, to
prove the check actually catches something rather than passing vacuously. Coverage thresholds are added with
the module they cover, not retrofitted, and are verified failing before they're made to pass.

**A test must be able to fail, and an infrastructure claim must be honest about what it can prove.** Where
something genuinely cannot be verified — no container runtime, no cloud account — the answer is not to skip
the check quietly or write one that can't fail; it's to say so explicitly.
[`docs/adr/ADR-0013`](docs/adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) sets three tiers
for exactly this: what runs and is proven here, what is authored and whose *semantics* are checked by parsing
it (never claiming it *works*, only that it's well-formed), and what is recorded `Fail — blocked` with the
missing resource named. Every milestone's Definition of Done carries its blocked lines openly rather than
narrowing the criterion until it quietly passes — that discipline is the reason this document could describe
a real, verified boot sequence instead of a plan.

---

Licensed under [MIT](LICENSE).
