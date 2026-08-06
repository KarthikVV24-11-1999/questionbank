# ADR-0002 — Architecture boundaries checked in-repo, not by dependency-cruiser
Status: Accepted
Date: 2026-08-05

## Context

M1-23 names dependency-cruiser as the tool that enforces F1 (cross-module imports go through `public/`
barrels) and F2 (`domain/` imports nothing).

dependency-cruiser refuses to run on the Node version in use: it supports `^22 || ^24 || >=26` and
exits with `ERROR: Your node version (23.3.0) is not supported`. TECH-STACK specifies Node 22 LTS, so
CI would be able to run it; a developer on Node 23 would not. Shipping a rule that only some machines
can execute means the rule is not enforced — and an unenforced fitness function is worse than none,
because it is believed.

## Decision

The rules are implemented in `apps/api/src/fitness/boundary-rules.ts` and executed by the normal test
suite (`pnpm fitness`, and as part of `pnpm test`). One implementation, runnable everywhere.

Detection parity with dependency-cruiser is a requirement of this decision, not an aspiration. The
checker resolves static `import`/`export … from`, bare side-effect `import 'x'`, dynamic `import()`,
and `require()` — the routes by which a module can reach another one. Each rule has a planted
violation fixture that proves it fires.

## Consequences

Makes easy: the check runs on every machine and in CI with no version constraint; violations are
reported as ordinary test failures with file and specifier.

Makes hard: the checker understands the four import forms above and nothing else. It does not resolve
`tsconfig` path aliases (the repo uses none) and does not follow re-export chains transitively.
Both are recorded as debt in M1-CLOSEOUT.md.

Forecloses: nothing. If dependency-cruiser becomes runnable, its config can replace this checker,
and the planted fixtures will validate the replacement.

Proof: `apps/api/src/fitness/boundary-rules.spec.ts` — 20 tests, including "fires on a planted
violation" (F1), "fires on a planted domain-layer violation" (F2 and DOMAIN_REACHES_OUTWARD), and
"catches a domain module evading the rule by dynamic import or require".

## Alternatives

**Ship a dependency-cruiser config anyway and let CI run it.** Rejected: a rule that fails to run
locally is discovered only in CI, and the config would be dead weight on every developer machine.

**Pin the repo to Node 22.** Rejected as out of scope for M1 and hostile to contributors; the version
floor belongs to M0's toolchain decision.
