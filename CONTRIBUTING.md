# Contributing

## Running the suite

```bash
corepack pnpm install
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Integration specs (`*.integration.spec.ts`) need a real Postgres 16 database; see the root
[README](README.md#how-to-run-it) for setup. `--workspace-concurrency=1` is required, because several
projects' integration suites share and reshape one schema.

## Commits

Conventional Commits: `<type>(<scope>): <subject>`, using `feat`, `fix`, `refactor`, `perf`, `test`,
`docs`, `build`, `ci` or `chore`. Scope is the bounded context (`content`, `curriculum`, `scoring`,
`generation`) or the app or package name. Imperative mood, no trailing period. The body explains why;
the diff already shows what.

## Two requirements

Architectural constraints ship with a test that has been shown to fail. If you add a boundary rule, a
coverage threshold, a secret scan or an immutability trigger, add the fixture that proves it catches
something, as the checks under `apps/api/src/fitness/` do.

Changes that contradict an approved document need an architecture decision record. If a change
disagrees with the roadmap, an architecture document or an earlier decision, add the record in
`docs/adr/` alongside the code.

## Conventions

[`docs/ENGINEERING-HANDBOOK.md`](docs/ENGINEERING-HANDBOOK.md) covers context boundaries, the error
taxonomy, testing strategy and the definition of done.
