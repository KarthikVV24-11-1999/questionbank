# ADR-0001 — NestJS arrives with the HTTP surface, not with the first handler
Status: Accepted
Date: 2026-08-05

## Context

M1-19 requires that "every handler declares an authorization policy; the module fails to boot without
one" (F36, BACKEND-ARCHITECTURE §5). The milestone plan notes NestJS as the scaffolding for M1-19.

M1-19 through M1-22 build command handlers, query handlers and their policies. None of them serve
HTTP, resolve a dependency graph at runtime, or need a DI container. The first task that does is
M1-26, the controllers.

A second constraint shaped the decision: vitest transforms TypeScript with esbuild, which does not
emit `design:paramtypes` metadata. Nest's type-based constructor injection therefore works under
`tsc` and fails silently under test — a difference that would have been discovered late.

## Decision

NestJS is introduced at M1-26, where controllers need it. F36 is enforced by `HandlerRegistry`, which
throws `MissingAuthorizationPolicyError` on registration of any handler without a policy, and by
`CurriculumModule.register`, which builds that registry and therefore cannot produce a module when a
policy is missing. All Nest injection uses explicit `@Inject(TOKEN)` rather than parameter types.

## Consequences

Makes easy: the application layer stays framework-free, so handler tests run with no container and no
decorators; the boot-time guarantee is a plain function that any composition root can call.

Makes hard: nothing observed. Should a future handler be registered outside `CurriculumModule`, the
guarantee travels with `HandlerRegistry`, not with Nest.

Forecloses: nothing. Adopting Nest's DI for handlers later remains possible.

Proof: `apps/api/src/contexts/curriculum/api/curriculum.module.spec.ts` — five tests, including a
planted policy-less handler and a policy that permits nobody, both of which prevent the module from
being built.

## Alternatives

**Introduce Nest at M1-19.** Rejected: it adds a container, decorators and metadata emission to a
layer that has no runtime need for them, and the esbuild metadata gap would have made handler tests
diverge from production wiring.

**Enforce F36 by review.** Rejected outright — the requirement is that forgetting authorization is
impossible, not that it is noticed.
