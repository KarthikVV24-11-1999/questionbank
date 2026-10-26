# Question Bank

A content platform for JEE/NEET exam preparation: a governed question bank, a versioned scoring engine, and
the authoring and review tooling that feeds them. It is being built content-pipeline-first — the storefront
and the learner-facing product come later, once there is a corpus worth delivering.

The API boots against PostgreSQL and serves authenticated requests, and the Studio builds and runs against
it. A learner can take a signed paper offline in `apps/learn`, and a real Chrome is killed and reopened against it a hundred times to see whether anything they did is lost (the gaps that remain are in `docs/DEBT.md`). 7,239 tests across nine workspace projects, with coverage floors enforced in the test run.

---

## Architecture

Four bounded contexts, each under `apps/api/src/contexts/`:

```
apps/studio ──▶ packages/contracts ──▶ apps/api
 (Studio UI)     (typed client,          ├─ contexts/curriculum/  taxonomy, exam profiles — no dependencies
                  generated from         ├─ contexts/scoring/     marking, scoring — mirrors curriculum's
                  OpenAPI)               │                        vocabulary as its own types; does not import it
                                         ├─ contexts/content/     items, versions, lifecycle, authoring,
                                         │                        review — imports scoring/public/ for the
                                         │                        answer-key projection only
                                         └─ contexts/generation/  AI item generation — proposes drafts to
                                                                   content; content does not depend on it
```

| Context | Owns | Depends on |
|---|---|---|
| `curriculum` | Taxonomy, concepts, exam profiles, marking rule sets | nothing |
| `scoring` | The marking executor, score records, rescoring | nothing — mirrors curriculum's vocabulary, asserted equal to it by a spec, never imports it |
| `content` | Items, versions, lifecycle, authoring, the review workspace | `scoring/public/`, for the answer-key projection only |
| `generation` | AI generation runs, candidates, the pre-check battery | `content/public/` and `curriculum/public/`; nothing depends on it |

Cross-context access goes through a context's `public/` barrel and nothing deeper. This is enforced by a
test — [`apps/api/src/fitness/boundary-rules.spec.ts`](apps/api/src/fitness/boundary-rules.spec.ts) — not by
convention: a planted import reaching past a barrel is asserted to fail.

`domain/` in every context is pure: no I/O, no framework, no clock, no randomness.

Nine workspace projects: `apps/api` (the backend), `apps/studio` (internal authoring/review frontend), `apps/learn` (the learner's exam shell),
`packages/content-renderer` (the one renderer authoring and delivery both use), `packages/contracts`
(generated OpenAPI types, Zod schemas, the typed client), `packages/domain-types` (the shared kernel), `packages/attempt-engine` (the offline attempt engine), and
`tools/seed` (deterministic fixture-data loader), and `tools/adversarial` (the adversarial suite: a real Chrome, killed and reopened). See [How to test it](#how-to-test-it) for each one's own
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

**The nine workspace projects**, each independently runnable with its own `test`/`typecheck` scripts — see
each project's own README for what it actually contains:

| Project | What it is |
|---|---|
| [`apps/api`](apps/api/README.md) | The NestJS backend: domain contexts, HTTP surface, platform adapters |
| [`apps/studio`](apps/studio/README.md) | The internal authoring/review frontend |
| [`apps/learn`](apps/learn/README.md) | The learner's exam shell: chrome-less, offline, drives the attempt engine |
| [`packages/content-renderer`](packages/content-renderer/README.md) | The one `ContentRenderer` implementation shared by authoring preview and student delivery |
| [`packages/contracts`](packages/contracts/README.md) | Generated OpenAPI types, Zod schemas, and the typed HTTP client |
| [`packages/domain-types`](packages/domain-types/README.md) | The shared kernel — types every context may depend on |
| [`packages/attempt-engine`](packages/attempt-engine/README.md) | The offline attempt engine — pure, no framework, no I/O, no clock |
| [`tools/seed`](tools/seed/README.md) | The deterministic fixture-data loader |
| [`tools/adversarial`](tools/adversarial/README.md) | The adversarial suite: the learner app in a real Chrome that is killed, crashed and reopened, with the network and the clock misbehaving |

**`apps/api` also has a `fitness` script** (`corepack pnpm --filter @questionbank/api fitness`) — the
architectural gate suite: boundary rules, coverage thresholds, secret scanning, and every other
correctness-bearing check that is not a unit test of product behaviour. It runs as part of `test`, but it is
worth knowing it exists separately. CI runs the same scripts on every push.

---

## Documentation

[`docs/README.md`](docs/README.md) indexes every document, one line each.
[`docs/ENGINEERING-HANDBOOK.md`](docs/ENGINEERING-HANDBOOK.md) covers the conventions this codebase
follows — context boundaries, the `public/` barrel rule, the error taxonomy and the local setup path.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) covers the system design, and
[`docs/DOMAIN-MODEL.md`](docs/DOMAIN-MODEL.md) the domain itself. Architectural decision records live
under [`docs/adr/`](docs/adr/).

---

Licensed under [MIT](LICENSE).
