# @questionbank/contracts

The typed HTTP client and the generated types both `@questionbank/api` and `@questionbank/studio` build
against, plus the fitness-checked seam between them. OpenAPI documents live under `openapi/` (`content.yaml`,
`curriculum.yaml`, `scoring.yaml`); Zod schemas and TypeScript types under `src/` are generated from them, not
hand-written, so the client and the server can never quietly drift out of sync (F15).

## How to run it

This is a library, not a runnable application. To regenerate types after an OpenAPI document changes:

```bash
corepack pnpm generate            # curriculum.yaml → src/curriculum.ts, via openapi-typescript
corepack pnpm generate:content    # content.yaml → src/content-schemas.ts, via the repo's own Zod generator
```

Regenerated output is committed — it is not built as part of `apps/api`'s or `apps/studio`'s own build, so
run the relevant `generate*` script and commit the diff whenever an `openapi/*.yaml` file changes.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest
```

Tests assert the generated Zod schemas match the OpenAPI documents byte for byte (so generated output cannot
silently diverge from a hand-edited fix), and exercise the typed client (`src/client.ts`) against fixture
responses, including its Problem Details error handling.
