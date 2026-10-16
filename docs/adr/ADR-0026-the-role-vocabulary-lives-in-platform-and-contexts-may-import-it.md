# ADR-0026 — The role vocabulary lives in `platform/auth`, and a context may import that one module

**Status** Accepted · M5 Track G, M5-36

## Context

Policies named roles as bare strings: 305 occurrences across four contexts, with no list and no check.
A typo yields a role no principal holds, so the policy authorizes nobody and the feature quietly never
works. That fails closed, which is correct, and therefore invisible; no test notices unless that exact
path runs under that exact role. The failure had been raised in four consecutive tracks while the
number of contexts naming `generation_pipeline` grew from one to three.

A role is a platform concept. A vocabulary owned by one context would be the wrong context owning it,
and the shared kernel (`@questionbank/domain-types`) is capped at exactly three types without an ADR
(ENGINEERING-HANDBOOK §9 rule 5), so it does not belong there either.

## Decision

`apps/api/src/platform/auth/roles.ts` holds the vocabulary: a closed `ROLES` constant, its derived
`Role` type, and `isRole`. It is a leaf — it imports nothing and holds no logic. Policies name a role as
`ROLES.contentOps`, never as the string.

**Contexts may import that one module from `platform/`, and no other.** This is a new direction of
dependency (contexts have imported nothing from `platform/` until now), so it is kept narrow on
purpose: `fitness/role-rules.ts` fails the build on a context file importing anything else under
`platform/`, because the day a context imports the composition root or the configuration the layering
is gone.

`fitness/role-rules.ts` also fails the build on a bare string, or a name `ROLES` does not have, in a
role position — the second argument of `policy(…)` (followed through constants and spreads), a
`roleContext:` value, a comparison or membership test on a role-named operand. It governs the
application and API layers of every context. `domain/` imports nothing (F2) and so cannot use the
vocabulary; the one role-valued constant there is held to it by a spec.

## Consequences

- An eleventh... or twelfth role is a reviewed change to `ROLES`; the spec holds the set to a literal
  list. The vocabulary found in the tree was eleven roles, not the seven that had been assumed: scoring
  names `ops`, `admin` and `system`, and content's delivery policy names `guest`.
- The substitution across contexts changed no policy: every exported policy's name, roles and step-up
  flag were dumped before and after and are identical.
- **Not decided here, deliberately:** whether a token's roles claim is validated against the
  vocabulary. That would change what a token is accepted for and is its own decision.
