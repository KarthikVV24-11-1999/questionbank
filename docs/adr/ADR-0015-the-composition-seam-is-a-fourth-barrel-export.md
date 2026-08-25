# ADR-0015 — The composition seam is a fourth barrel export
Status: Accepted
Date: 2026-08-13

## Context

[M0-WALKING-SKELETON.md, DEC-M0-5](../tasks/M0-WALKING-SKELETON.md#dec-m0-5--the-composition-root-lives-in-platform-and-reaches-contexts-through-a-fourth-barrel-export-adr-0015)
poses the seam question the composition root needs answered: `platform/composition/app-factory.ts` (M0-12)
must be able to build each context's `DynamicModule` — resolving its repositories, its platform-port
adapters, and its full handler population — without importing a context's `application/` or
`infrastructure/` directly, because that would violate the oldest gate in this repository (F1: cross-module
imports go through `public/` barrels only). [ENGINEERING-HANDBOOK](../ENGINEERING-HANDBOOK.md) §1 says a
barrel exports exactly three things — commands, queries, events — and none of those is a `DynamicModule`,
a repository, or a handler.

## Decision

Each context gains a fourth export, `public/composition.ts`, sitting beside `public/index.ts` as a **separate
module path**, never re-exported through it. It exports one function, `register(deps): DynamicModule`, that:

- constructs the context's own repositories from a `Pool` (or a `NodePgDatabase` built from one),
- accepts the platform-level ports that context's handlers need — named precisely, not as a generic bag —
  as its `deps` parameter (content's names `RenderValidator`, `MediaStore`, `IdempotencyStore`; curriculum's
  and scoring's do not, because their handlers do not use them),
- builds the complete population of real handler instances the context's `api/*.module.ts` needs, and
- calls that module's own `.register({ handlers, principals })` — already established at M1/M2/M3 — and
  returns its `DynamicModule` unchanged.

`platform/composition/` (M0-12) imports only `contexts/*/public/composition.js` and `contexts/*/public/index.js`
— nothing deeper. **`public/index.ts` does not import `public/composition.ts`**, proven by a spec in each
context: `m4-seam.spec.ts` and every other barrel consumer stays free of NestJS, Express, and `pg`, which is
exactly the property that made those specs cheap to run before this ADR and must stay true after it.

**Missing a required dependency is refused at runtime, not only by the type system.** `register` checks
every key in its own `deps` parameter is present before constructing anything, and throws immediately if
one is not — proven against a deps object reached through a cast, simulating a caller who bypassed the
type system entirely (a hand-assembled config object, say). This is the same posture F11 already takes
for a policy-less handler: a boot failure the instant composition runs, not a failure deferred to the
first request that happens to touch the missing port.

**Two ports without a production adapter are wired with the in-memory double, as the production choice.**
Content's `register` wires `InMemoryReviewProgress` (nothing has claimed a version, so `hasBegun` is always
`false` until M4 supplies a real adapter — exactly the behaviour finding W4 already documents) and
`InMemoryEntitlements` (nothing is granted, so `allows` is always `false` until an entitlement service
exists — safe because INV-08 means the delivery solution query never asks it about basic correctness, only
about paid depth). Neither is a shortcut disguised as a wiring detail: both are named, and both are what
M4's own composition change replaces.

## Amended by M4-30 (2026-08-21)

**`InMemoryReviewProgress` is gone, not replaced by another double.** The paragraph above is superseded for
`ReviewProgress` only — `InMemoryEntitlements`'s half is unchanged and still current.

M4 landed real claims (`content.review_assignment`, M4-18/M4-27), so W4's question ("has a reviewer started
on this version") has a real answer to read rather than a port with a hardcoded one. `register` no longer
constructs `InMemoryReviewProgress` or wires a `reviewProgress` field; `WithdrawItemFromReviewHandler`
(`application/handlers/lifecycle-handlers.ts`) instead calls `ReviewAssignmentRepository.hasLiveClaim`
directly, inside its own transaction, using the `assignments` dependency `register` already builds for
M4-27's handlers. Nothing new is wired here — the change is that one fewer thing is.

The property this closes over is stronger than the port it replaces could ever promise: `hasLiveClaim`
locks the same `content.item_version` row `claimNext`'s `FOR UPDATE OF v SKIP LOCKED` locks, so a claim and
a withdrawal racing in overlapping transactions resolve to exactly one winner — a guarantee that depends on
both operations sharing the database's own row-level locking, which no port interface and no read-only
projection could have expressed.

## Consequences

**Makes easy:** a repository or a handler added to a context never touches `platform/composition/` — the
change is local to that context's own `public/composition.ts`. `createApplication` (M0-12) composes three
function calls, not three contexts' worth of import paths.

**Makes hard:** two contexts now have two barrel-shaped files instead of one, and a reader has to know
`composition.ts` is deliberately not part of "the barrel" `index.ts` is. The naming (`public/composition.ts`,
never re-exported) is what keeps that distinction visible rather than accidental.

**Forecloses nothing.** A context whose handler population changes shape entirely (a repository split in
two, a handler renamed) edits one file; `platform/composition/`'s three call sites do not change.

**Scoring's `register` is not yet complete, and this is recorded rather than hidden.** Composing content
(37 handlers) and curriculum (22 handlers) surfaced no design gap beyond routine wiring — described fully
in the M0 progress log. Scoring's `ScoreRecordRepository` surfaced a real one: its concrete
`PostgresScoreRecordRepository` requires `examProfileVersionId` and `taxonomyVersionId` at
**construction**, supplied once, while the handlers that use it (`ScoreAttemptHandler` and every rescoring
handler) serve requests spanning every exam profile through one shared instance — and neither `ScoreAttempt`
nor `ScoreRecord` carries that pin far enough for a per-call adapter to derive it honestly.
Hardcoding one profile's identifiers at composition time would make scoring silently wrong for every other
profile, which is worse than an unrouted handler — ADR-0008's own reasoning for holding scoring's domain to
100% coverage applies here with equal force to composition. This is a repository-port design question
scoring's own context must answer, not a composition-root wiring gap this ADR's pattern can paper over.
Content's and curriculum's `register` are both complete and proven — every handler their respective OpenAPI
documents name resolves through the real, composed registry.

## Alternatives

**A closed exception in F1 letting `platform/composition/` import a context's `application/`/`infrastructure/`
directly.** Rejected: DEC-M0-5 already weighed this and rejected it — amending the oldest gate in the
repository to fit new code is backwards from amending documentation to record a considered divergence,
which is the choice every other ADR in this set has made when a rule needed to bend.

**One `platform/composition/` file per context, still reaching past each barrel.** Equivalent to the
rejected alternative above under a different file name; the barrel boundary is what F1 checks, not which
file does the reaching.

**A single, generic `ContextModule` factory taking a context name and a deps bag.** Rejected: it would need
to know each context's handler population and dependency shapes anyway, which means it either duplicates
what each context's own `composition.ts` already knows or reaches into `application/` to discover it — the
first is redundant, the second is the violation this ADR exists to avoid.
