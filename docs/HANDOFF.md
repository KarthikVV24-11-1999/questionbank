# Handoff — Design Complete, Implementation Starting

**State as of 2026-08-05:** 17 design documents in `docs/`. **Zero code exists.** The repository is empty apart from `docs/`.

## Where to start

**Task M1-01 — `ConceptIdentity` aggregate.** Full spec: [tasks/M1-CURRICULUM-SPINE.md](tasks/M1-CURRICULUM-SPINE.md) → M1-01.

## Required reading for this task — these only, not all 17

| Document | Read |
|---|---|
| [tasks/M1-CURRICULUM-SPINE.md](tasks/M1-CURRICULUM-SPINE.md) | M1-01 spec, and the scope-boundary note at the top |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §1 folder structure · §2 naming · §5 testing · §9 architecture rules |
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md) | §0 conventions · §2 D1 (identity/version split) · §4 `ConceptIdentity` |

## Scaffolding note

M1-01 is **pure domain logic — no I/O, no framework, no ORM.** M0 (Compose, CI, Terraform, ECS) is not required to write and test it.

The implementing session may create the **minimum** scaffolding needed: pnpm workspace root, `apps/api` package with `tsconfig` and `vitest` config, and the `contexts/curriculum/domain/` directory. Nothing further — no NestJS bootstrap, no Docker, no database.

## Non-negotiables for every task

- `domain/` imports nothing — not the ORM, not the framework, not another context
- Files `kebab-case.ts`; classes `PascalCase`; aggregate named the domain noun exactly (`ConceptIdentity`, never `ConceptIdentityEntity`)
- Unit tests are `*.spec.ts`, colocated, no I/O
- A bug fix ships with the test that would have caught it
- Commits: `feat(curriculum): <imperative subject>`

## After M1-01

M1-02 → M1-04 continue the taxonomy domain. M1-05 → M1-09 (value objects) and M1-14 → M1-15 (schema) can run in parallel from day one. Critical path and sequencing: task doc, final section.

## Open items requiring the user, not engineering

Nine remain, listed in [DECISIONS.md](DECISIONS.md) §D. None block M1. The two that matter most are launch corpus size and pricing validation.
