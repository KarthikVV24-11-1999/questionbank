# ADR-0011 — The pnpm workspace stands in for Turborepo, with a named trigger
Status: Accepted
Date: 2026-08-13

## Context

[TECH-STACK](../TECH-STACK.md) §1 selects "Turborepo + pnpm" for the monorepo. By M0, the repository has
a working pnpm workspace with seven projects (`apps/api`, `apps/studio`, `packages/content-renderer`,
`packages/contracts`, `packages/domain-types`, `tools/seed`, plus the root) and per-project vitest and
`tsc` configuration that three milestones — M1, M2, M3 — have already been delivered against, entirely
without Turborepo.

## Decision

**Turborepo is not adopted in M0.** `pnpm -r` stands for every root script (`test`, `typecheck`, `seed`).

Two independent facts decide this, and either alone would be sufficient.

**It is not installable today.** `turbo` is not present in `node_modules/.pnpm`, and M0 runs with no
network (`corepack pnpm install --offline` resolves from the store only). Adoption is not a
churn-versus-benefit question; it is not possible at any price until a developer with network access adds
it.

**Its entire value is realised in CI, and this repository has no CI runner to realise it against.**
Remote caching skips re-running a task whose inputs haven't changed *between CI runs*. Task-graph
parallelism speeds up a build *on a machine running many cores against many independent projects*.
Change detection scopes a CI job to *the projects a PR actually touched*. All three pay off against a CI
wall clock — a resource that does not exist in this environment (M0 authors the workflow file at Tier 2;
see [M0-WALKING-SKELETON.md, DEC-M0-1](../tasks/M0-WALKING-SKELETON.md#dec-m0-1--what-done-means-for-a-deliverable-that-cannot-be-executed-here)
and DEC-M0-3). Adopting Turborepo now would add a configuration surface — `turbo.json`, task pipelines,
cache key tuning — that no test in this repository can exercise, in exchange for a benefit no test in
this repository can observe.

`pnpm -r` already does what M0 needs: run every project's script, workspace-wide, using the dependency
graph pnpm already understands from `pnpm-workspace.yaml`.

## Consequences

**Makes easy:** the M0 exit is not gated on a package that cannot be installed. Nothing about how a
developer runs tests or typechecks changes from what M1–M3 already established.

**Makes hard:** cross-project caching and change-scoped CI jobs are not available. At today's size — seven
projects, no CI runner — this cost is unobserved.

**Forecloses nothing.** `pnpm -r`'s task graph is a strict subset of what Turborepo needs to know;
migrating later is additive configuration, not a rewrite.

**Named trigger, not an open-ended "later":** adopt Turborepo at whichever comes first —

1. the first CI run (once a provider is connected, per M0-21) where `corepack pnpm -r test` exceeds the
   10-minute feedback budget ([TECH-STACK](../TECH-STACK.md) §2), or
2. the workspace reaching a sixth *application or package* project (`tools/` entries do not count — they
   are not part of the deployable surface Turborepo's caching is meant to speed up).

A divergence from an approved document with no numeric trigger is how the document becomes unreliable —
the same reasoning [ADR-0010](ADR-0010-content-owns-the-lifecycle-state-machine.md) records for its own
divergence from ROADMAP M4.

## Alternatives

**Adopt Turborepo now, accepting the configuration cost.** Rejected: it is not installable in this
environment regardless of merit, and the question is moot until it is.

**Wait for Turborepo and block M0 on it.** Rejected: M0 is already the milestone three prior milestones
have been waiting on; blocking it further on a package with no network path to install would extend that
wait indefinitely rather than for a bounded reason.

**Drop Turborepo from TECH-STACK entirely.** Rejected: TECH-STACK's stated reason — "three apps and shared
packages need caching and workspace linking, not the configuration surface of Nx" — is still the right call
once a CI runner exists to make caching meaningful. This ADR is a deferral, not a reversal.
