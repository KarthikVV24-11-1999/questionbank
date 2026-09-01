# ADR-0023 — The CI workflow is executed, and leaves Tier 2
Status: Accepted
Date: 2026-09-01

## Context

[ADR-0013](ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) placed `.github/workflows/ci.yml`
at **Tier 2 — authored and asserted**: the file exists, `ci-rules.spec.ts` parses it and checks its
semantics, and every one of those assertions is shown to fail against a planted mutation of the file.
Tier 2's binding rule is that such an artifact "never claims a Tier-1 property" — so nothing in this
repository claimed the workflow *ran*. Several places said the opposite, in as many words: the
workflow's own header, `ci-rules.ts`, the spec's first test name, and the README's known-gaps list.

That was true for five milestones. It is no longer true. The repository is now hosted, the workflow has
been executed by GitHub Actions, and its five jobs have produced results a person can read.

ADR-0013 rule 2 anticipated exactly this moment and named the successor check — "the CI run" — so that
upgrading the claim "is a checklist, not an archaeology exercise". This ADR is that checklist.

## Decision

**The CI workflow moves from Tier 2 to Tier 1**, and every statement in the tree that says it has never
run is corrected: the workflow header, `ci-rules.ts`, `ci-rules.spec.ts`'s first test name, and
`README.md`'s known-gaps list.

**Tier 1's definition widens by one word.** ADR-0013 defines Tier 1 as "runs *here*, against Node 22 and
the local Postgres", because when it was written the only executor in existence was this machine. The
tier was never about geography — it was about whether a claim rests on an execution somebody can point
at. It now reads **runs, in an environment whose result is observable and reproducible**: this machine,
or the CI runner, both of which stand behind a claim in the way parsing a file does not.

**Nothing else moves.** The Compose stack and the Terraform configuration stay at Tier 2, and Compose's
boot time stays absent from this repository, because neither has been executed by anything. A CI runner
existing does not entitle any other artifact to a claim it has not earned.

## Consequences

**Makes easy:** the assertions `ci-rules.spec.ts` makes about the workflow are now backed by the
workflow having actually done what it declares. `pnpm install --frozen-lockfile` really does resolve on
a clean machine; the job graph really does schedule; the Postgres service container really does accept
the integration suite's connection. None of that was knowable from parsing, and all of it was assumed.

**The first executions failed, which is the point.** Two tests that had passed on every local run since
they were written failed on the runner, and both for the same reason: they asserted a duration rather
than a condition. A source scan that followed pnpm's symlinks read 60 MB it did not need and exceeded a
five-second timeout; an undo-window test raced a 20 ms wall-clock window against an awaited click that
nothing bounds. Both were latent defects in the tests, both were invisible to a Tier-2 parse by
construction, and both are exactly what Tier 2 was told never to claim it had ruled out. They are fixed,
and ENGINEERING-HANDBOOK §5 now carries the rule they violated.

**Makes hard:** a red build is now a real, visible event with a cost, where previously the workflow could
not be wrong in any way that showed. That is the trade Tier 1 always implied.

**Arms [ADR-0011](ADR-0011-pnpm-workspace-stands-in-for-turborepo.md)'s first Turborepo trigger.** That
ADR deferred Turborepo partly because "its entire value is realised in CI, and this repository has no CI
runner to realise it against", and set a numeric trigger: the first CI run where the workspace test
command exceeds the 10-minute feedback budget ([TECH-STACK](../TECH-STACK.md) §2). There is now a wall
clock to measure against, and the first measurement is **2 m 44 s** for
`corepack pnpm -r --workspace-concurrency=1 test`. The trigger is armed and not met. It is a live
measurement now rather than a hypothetical, which is the whole reason it was written as a number.

## Alternatives

**Leave the Tier-2 wording in place and treat the CI run as incidental.** Rejected: this repository's
rule is that a document found wrong is corrected rather than left to age, and four separate places
asserting "never executed" would each be a small lie that a reader has no way to detect. The cost of
leaving them is not the wording — it is that the next person reads Tier 2's guarantees and calibrates
their trust in the whole tiering scheme against a claim that is false.

**Promote Compose and Terraform at the same time, on the grounds that CI could now run them.** Rejected:
*could* is Tier 2's whole failure mode. The workflow runs neither today. Each moves when it is executed,
on its own evidence, exactly as this one did.

**Redefine Tier 1 broadly — "any execution anywhere" — rather than by one word.** Rejected as too loose:
a run whose output nobody can retrieve, or which cannot be reproduced, backs a claim no better than a
parse does. Observable and reproducible are the two properties that make an execution worth citing, so
they are the two the definition names.
