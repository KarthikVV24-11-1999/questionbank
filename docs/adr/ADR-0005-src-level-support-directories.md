# ADR-0005 — Four support directories under `apps/api/src`
Status: Accepted
Date: 2026-08-05

## Context

ENGINEERING-HANDBOOK §1 fixes the anatomy of `apps/api/src` as `contexts/` and `platform/`, and states
that adding a top-level directory requires an ADR. M1 added four:

| Directory | Holds | Why not elsewhere |
|---|---|---|
| `src/testing/` | Test doubles, fixtures, the golden hash file, the database harness | Imported only by specs; colocating fixtures inside `contexts/` would put test-only code inside the context anatomy |
| `src/fitness/` | The F1/F2 boundary checker (ADR-0002) | §1 places fitness checks in `tools/fitness/`; this one must import from `src` and run in the api test suite |
| `src/fitness-fixtures/` | Deliberate architecture violations that prove the checker fires | Must live where the checker scans, and must be excluded from the checker's own pass |
| `src/contracts/` | The OpenAPI contract test | Reconciles the spec against the handler registry, so it belongs to the api package rather than `packages/contracts` |

## Decision

The four directories stand. All are excluded from production concerns: none is imported by
`contexts/` or `platform/` code, and `src/testing`, `src/fitness-fixtures` and `src/fitness` are
excluded from coverage.

## Consequences

Makes easy: test support and fitness checks live next to what they check and run in the ordinary suite.

Makes hard: `src/fitness` diverges from §1's `tools/fitness/` location. If a second context needs the
same checker, it should move to a shared package rather than be copied.

Forecloses: nothing.

## Alternatives

**`tools/fitness/` per §1.** Rejected for now: the checker imports the barrel and scans `apps/api/src`,
and a separate workspace package for one file adds a build boundary with no benefit. Revisit when a
second context exists.

**Colocate fixtures inside `contexts/curriculum/`.** Rejected: test doubles inside the context anatomy
blur the five-directory rule §1 exists to protect.
