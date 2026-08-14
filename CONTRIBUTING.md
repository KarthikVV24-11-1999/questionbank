# Contributing

## Running the suite

```bash
corepack pnpm install
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Integration specs (`*.integration.spec.ts`) need a real Postgres 16 database — see the root
[README](README.md#how-to-run-it) for setup. `--workspace-concurrency=1` is required: several projects'
integration suites share and reshape one schema.

## Commits

Conventional Commits: `<type>(<scope>): <subject>` — `feat`, `fix`, `refactor`, `perf`, `test`, `docs`,
`build`/`ci`, `chore`. Scope is the bounded context (`content`, `curriculum`, `scoring`) or the app/package
name. Imperative mood, no trailing period. The body explains *why*, not what — the diff already shows what.

## The two rules that aren't optional

**Every architectural constraint is a test that must be proven able to fail.** A boundary rule, a coverage
threshold, a secret scanner, an immutability trigger — none of it is trusted on review alone. If you add a
constraint, add the planted violation that shows it catches something, the same way every check under
`apps/api/src/fitness/` already does.

**A change that diverges from an approved document needs an ADR.** If your change contradicts something
`docs/` says is true — the ROADMAP, an architecture doc, a prior ADR — write the ADR before or alongside the
code, in `docs/adr/`, stating what changed and why. A divergence that isn't recorded is how the documentation
becomes unreliable for the next person.

## Everything else

See [`docs/ENGINEERING-HANDBOOK.md`](docs/ENGINEERING-HANDBOOK.md) — context boundaries, the error taxonomy,
testing strategy, and the rest of what "done" means here.
