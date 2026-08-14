# @questionbank/seed

Deterministic fixture-data loader: a demo exam profile, taxonomy and sample items, built from the domain
constructors the interactive path uses (never a parallel loader that could drift), and written against
whatever `DATABASE_URL` is exported when it runs.

## How to run it

Requires a reachable, migrated Postgres database — see the repository root README for how to create and
migrate one:

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"
corepack pnpm --filter @questionbank/seed run seed
```

Safe to re-run against a database that already has seed data; it does not assume a clean database.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest
```

`*.integration.spec.ts` files (including the fixture data files under `data/`, each of which validates its
own taxonomy or profile) need a real database and follow the same `DATABASE_URL` convention as `apps/api`.
`*.spec.ts` files run without one.
