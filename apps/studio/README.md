# @questionbank/studio

The internal frontend for authoring and reviewing content — item editing, taxonomy management, exam profile
management, and (from M4 onward) the review workspace. Not learner-facing. Talks to `@questionbank/api`
exclusively through the typed client in `@questionbank/contracts` — no other `fetch` is permitted anywhere
in this package (F15), and that rule is enforced by a fitness function in `apps/api`, not by review.

## How to run it

```bash
corepack pnpm dev     # Vite dev server
corepack pnpm build   # production build — no sourcemaps, deliberately (see vite.config.ts)
```

The dev server expects `@questionbank/api` running separately (see [`apps/api/README.md`](../api/README.md))
and talks to it through the generated client — there is no dev-server proxy configured. Below 1280px viewport
width the shell renders an explicit "use a larger screen" gate rather than a broken authoring surface; this is
intentional, not a responsive-design gap.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest + jsdom, with coverage
```

Every test here runs in jsdom — there is no Playwright or other browser-driven E2E suite in this repository
yet (deferred; see debt item D2 in the milestone close-out documents). Component tests are written against
`@testing-library/react`; accessibility is checked with `axe-core` as part of the same suite, not separately.
