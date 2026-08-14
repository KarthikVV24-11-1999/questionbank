# @questionbank/api

The backend: a NestJS application composing independent bounded contexts (`content`, `curriculum`, `scoring`,
each under `src/contexts/`) over a shared `platform/` layer (config, auth, observability, persistence). Cross-
context access goes through a `public/` barrel only, enforced by a boundary-checking fitness function, never
by convention.

## How to run it

No build step — `start` runs the TypeScript source directly via `vite-node`. Requires a reachable Postgres
16 database, already migrated, and every key `src/platform/config/config.ts` reads exported as an environment
variable (see the repository root [`.env.example`](../../.env.example)):

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"
export PORT=3000 NODE_ENV=development AUTH_SIGNING_KEY="$(openssl rand -hex 32)" \
       AUTH_ISSUER=questionbank AUTH_TOKEN_TTL_SECONDS=3600 MEDIA_STORAGE_ROOT=./var/media LOG_LEVEL=info
corepack pnpm start
```

`GET /healthz` and `GET /readyz` should both return `200`; the latter confirms the database connection. See
the repository root README for the full setup path, including migrating a fresh database and issuing a
bearer token to reach an authenticated route.

## How to test it

```bash
corepack pnpm typecheck   # tsc --noEmit
corepack pnpm test        # vitest, with coverage
corepack pnpm fitness     # the architectural gate suite only — boundary rules, secret scanning, coverage thresholds
```

`*.integration.spec.ts` files open a real Postgres connection and need `DATABASE_URL` pointed at a reachable
database (defaults to `questionbank_test` on port 5432 if unset — the port Compose will publish once that
path is verified). `*.spec.ts` files are pure unit tests with no I/O and run without a database.

Integration suites reshape a shared schema as they run, so when testing across the whole workspace use
`corepack pnpm -r --workspace-concurrency=1 test` from the repository root, not a bare `pnpm -r test`.
