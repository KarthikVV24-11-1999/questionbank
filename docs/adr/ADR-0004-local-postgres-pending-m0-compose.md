# ADR-0004 — Integration tests run against a locally installed Postgres until M0 lands
Status: Accepted
Date: 2026-08-05

## Context

M1's quality bar requires that integration tests use a real Postgres, never a mock. The intended host
is the Compose stack (F8: "full Compose stack boots in ≤ 10 minutes"), which belongs to M0.

M0 does not exist. The development machine used for M1 has no Docker, no Compose, and no container
runtime of any kind.

## Decision

M1 was built and verified against PostgreSQL 16.14 installed via Homebrew, running as a project
cluster on port 5433 (`~/.questionbank-pg`, trust auth, socket `/tmp`). Every integration test,
migration cycle and seed run in M1 executed against that server.

No code depends on this arrangement. Both database URLs are
`process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/…'` — defaulting to the port Compose
will publish, with the local cluster reached by exporting `DATABASE_URL`. The two references are
`apps/api/src/testing/database.ts:15` and `tools/seed/index.ts:117`; both are test/tool support, not
shipped runtime.

## Consequences

**F8 cannot pass and is not claimed.** The Definition of Done item "Included in the Compose boot
verification" is recorded as failed-blocked, not as passed. Likewise "deployed to staging".

Makes easy: M1 was verified against a real database rather than deferred behind missing infrastructure.

Makes hard: a developer cloning the repo today must supply their own Postgres and set `DATABASE_URL`.
M0 removes that step.

When M0 lands, the verification to run is: bring up Compose, leave `DATABASE_URL` unset, and confirm
the suites and `pnpm seed` pass against port 5432 with no further change.

## Alternatives

**Mock the database.** Rejected — the quality bar forbids it, and the triggers, constraints and
JSONB behaviour under test exist only in a real Postgres.

**Add `embedded-postgres` to the repo.** Rejected: it downloads binaries on install for every
developer and duplicates what Compose is already specified to provide.

**Defer Track B until M0.** Rejected: it would have stalled six tasks on infrastructure that is not
M1's to build.

## Amended by M0 (2026-08-14)

Three facts, and nothing else changes:

1. **The Compose file now exists** — `infra/compose/docker-compose.yml` (M0-20), publishing Postgres on
   5432, per the plan this ADR already named as "when M0 lands."
2. **Both `DATABASE_URL` defaults are unchanged**, still pointing at 5432 (`apps/api/src/testing/database.ts:15`,
   `tools/seed/index.ts:117`) — the file is the documented target, not a departure from it.
3. **F8 remains `Fail — blocked`, and the verification this ADR names is still unrun.** Authoring the
   Compose file is Tier 2 (ADR-0013); it proves the file parses and declares the right health-check shape,
   not that anything has booted. ADR-0004 is superseded by the first *green* Compose boot, and by nothing
   else — when that happens, this section becomes a one-line edit.
