# ADR-0008 — The 100% rule follows correctness-bearing code, not layer
Status: Accepted
Date: 2026-08-07
Supersedes: the domain-versus-application scoping applied at M2-34
Relates to: ENGINEERING-HANDBOOK §5 (MNT-03)

## Context

The handbook requires 100% branch coverage on "scoring, marking, entitlement".
M2-34 read that as *the scoring domain plus the two repositories*, and excluded
the application layer with the argument that it "orchestrates and decides
nothing about what a mark is".

That argument is wrong, and it is wrong in the direction that matters.

The application layer is where the **pinning** happens. `ScoreAttemptHandler`
decides whether an attempt is scored at all — its idempotency check can return
an existing record instead — and carries the rule set, its hash, the schema
version and the aggregation spec into the executor. `previewScope` in the
rescoring handlers resolves which attempts are in scope, which record each
successor supersedes, and what generation it becomes.

A bug in any of those does not crash and does not produce an obviously wrong
number. It produces **a correct score computed over the wrong inputs**: the
arithmetic is right, every invariant holds, the record is internally consistent
and explainable, and the total is wrong. That failure survives review precisely
because everything about it looks right. It is worse than the arithmetic bugs
the domain gate was built to catch, and it was sitting outside the gate.

Authorization belongs on the same side of the line. A re-score that runs
without step-up changes results people have already been told; whether that
path is reachable determines what gets scored just as surely as the rule set
does.

## Decision

The 100% rule covers every module that determines **what gets scored or how**,
regardless of which layer it sits in:

| In scope | Why |
|---|---|
| `scoring/domain/**` (runtime modules) | Decides what a mark is |
| `infrastructure/score-record.repository.ts` | Carries the pin across persistence |
| `infrastructure/rescoring-operation.repository.ts` | Guards the approval against a lost update |
| `application/handlers/scoring-handlers.ts` | Resolves whether to score, and pins the versions |
| `application/handlers/rescoring-handlers.ts` | Resolves scope, generation and predecessor |
| `application/authorization.ts` | Decides whether a re-score runs at all |
| `application/handler-registry.ts` | The F36 gate that guarantees the above runs |
| `application/queries/scoring-queries.ts` | Renders every mark a learner is shown |

Out of scope, and stated rather than left implicit: modules that only move a
finished result around (`outbox-emitter.ts`, `infrastructure/schema.ts`, the
HTTP controller and its DTOs — all covered by their own integration specs under
the overall gate), and type-only modules, where a threshold asserts nothing
because there is no runtime code.

`scoring-rules.spec.ts` polices the list: it fails if any in-scope module has no
threshold, if any threshold is below 100 on any of the four metrics, or if a
named module has been deleted without the list being updated.

## Consequences

Raising the newly in-scope modules to 100% required 31 new tests, and they are
not padding. Every one exercises a failure path that the happy-path integration
suite never reaches:

- a save rejected after the score was computed
- a dry run over an attempt with no current record
- an execution whose successor cannot be written
- an operation that changes state between being read and being completed
- every rescoring command against a principal without the role

One dead export was found and removed while doing it: `authorizeOwnAttempt` in
`application/authorization.ts` duplicated the ownership check the queries
already had inline, and was never called. It would have passed a coverage
threshold by being deleted, which is the honest outcome.

Makes easy: catching the class of defect that yields a plausible wrong answer.

Makes hard: adding a handler to the scoring context, which now costs its failure
paths as well as its happy path. That is the intended price.

## Alternatives

**Keep the domain/application split.** Rejected: it draws the line at a
structural boundary rather than a risk one, and leaves the pinning logic —
where a bug is least visible — outside the gate.

**Put every scoring module at 100%.** Rejected: it forces thresholds onto
type-only files that have no branches, which reports a number without asserting
anything and trains people to read the gate as noise.
