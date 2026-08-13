# ADR-0016 — The API type-checks the renderer package
Status: Accepted
Date: 2026-08-13

## Context

`application/ports.ts` named **D27** — no production adapter for `RenderValidator` — "a composition gap
rather than a design one," and pointed at the reason in its own words: *"calling `validateRender` from the
API means running a React render inside the Node service."* `render-validation.ts`'s own header makes the
same point independently: `renderFor` calls `ContentRenderer(...)`, a component defined in
`content-renderer.tsx`.

[M0-WALKING-SKELETON.md's M0-09 entry](../tasks/M0-WALKING-SKELETON.md) mis-stated this. It claimed *"`renderFor`
uses `renderToStaticMarkup`, so no JSX transform is needed in the API build."* That is false, and the
falseness was concrete rather than theoretical: `apps/api`'s own `tsc --noEmit`, with no `jsx` compiler
option set, failed the moment `render-validator.adapter.ts` imported `render-validation.ts` — not because
`renderFor` itself contains JSX syntax (it does not), but because TypeScript, resolving `content-renderer`
to its **source** rather than a pre-built `.d.ts` (there is no build step in this repository — see
Alternatives), must type-check `content-renderer.tsx` to know what `ContentRenderer(...)` returns. A React
render inside the Node service, which D27's own comment already named, always implied type-checking a
`.tsx` file from `apps/api`'s compiler. The entry's premise was wrong; the underlying design fact it was
built on was right.

A second, independent defect surfaced in the same typecheck run: the renderer's `MediaBlock.caption` was
typed `string` while the content domain's has been `readonly Inline[]` since M3. `renderer-seam.spec.ts`
only ever compared the vocabulary's *kind names*, never a variant's *shape*, so the divergence shipped for
a milestone undetected. That defect is fixed and closed separately (see the commit
`fix(content): render a media caption as authored inlines` and the seam spec's new field-by-field checks)
and is not this ADR's subject — it is mentioned here only because both surfaced from the same typecheck run
and a reader piecing together M0-09's history should not have to guess whether they were one problem or two.

## Decision

**`apps/api/tsconfig.json` gets `"jsx": "react-jsx"`.** The API carries the renderer package's type and
runtime weight — `react` and `react-dom` are dependencies (added at M0-09), and `apps/api`'s compiler now
checks `.tsx` source the same way `packages/content-renderer`'s own compiler does.

**The API authors no JSX of its own.** The `jsx` option exists for exactly one reason — type-checking an
*imported* package — and never as license to write a component under `apps/api/src/`. That boundary is
enforced, not stated: `checkNoTsxFiles` (`apps/api/src/fitness/platform-rules.ts`) scans `src/` for any
`.tsx` file and fails if one exists, proven against a planted fixture at
`fitness-fixtures/as-api-tsx/planted-component.tsx`. The check is true today — zero `.tsx` files exist
under `apps/api/src/api/`, `application/`, `domain/`, `infrastructure/`, `platform/`, or anywhere else in
the project — and stays true because the gate makes it a build failure to add one.

## Consequences

**Makes easy:** `RenderValidatorAdapter` (M0-09) calls the real renderer with no worker process, no IPC, no
second runtime — `render-validator.adapter.ts` is plain TypeScript, contains no JSX, and the publication
precondition (M3-11) now runs against a real render rather than a test-supplied fact. D27 closes.

**Makes hard:** `apps/api`'s dependency graph now includes `react`/`react-dom`/`@types/react`, and its
`node_modules` and typecheck surface are larger than a pure Node service would otherwise need. This is the
cost D27's own comment already accepted in principle — "a composition gap rather than a design one" meant
the design already implied this weight; M0-09 is where the bill arrives.

**Forecloses nothing new.** `checkNoTsxFiles` is the backstop that keeps the concession narrow: the JSX
capability exists for one file's import chain, and any attempt to widen that into "the API renders its own
views" is a fitness-function failure, not a silent drift.

## Alternatives

**Build `content-renderer` to `.d.ts` and have `apps/api` consume the compiled output.** Rejected: this
repository has no build step for its internal packages — every workspace package is consumed as source,
resolved through `moduleResolution: "Bundler"` directly against `.ts`/`.tsx` files (`exports` maps point at
`src/*.ts(x)`, not a `dist/`). Adding a build step means adding a bundler or `tsc --emitDeclarationOnly`
pipeline, a `prepare`/`build` script per package, and a new class of "did you rebuild before testing"
failure — to a repository that runs entirely offline
(`corepack pnpm install --offline`, [HANDOFF-M4.md](../HANDOFF-M4.md)) and has deliberately stayed free of
one through M1, M2 and M3. The cost is a real build system; the benefit is narrowing one compiler option to
one file's import chain, which `checkNoTsxFiles` already narrows without it.

**Run the renderer in a separate worker process, reached over IPC.** Rejected: this is what M0-09's
original (wrong) premise was trying to avoid paying for by not needing JSX at all. Since JSX support turns
out to be unavoidable regardless, a worker process would add a second runtime, a serialization boundary for
`ItemVersion`, and a new failure mode (the worker is unreachable) for no longer benefit than the
in-process adapter already provides — the render is synchronous, pure, and does not need isolation from
the request that calls it.

**Give `apps/api` its own copy of the block/inline vocabulary with a hand-written render check, avoiding
the renderer package entirely.** Rejected outright: this is the exact drift DEC-2 and F20 exist to prevent
— a second renderer implementation, or a second thing pretending to validate rendering without actually
rendering, is worse than the JSX dependency it would avoid.
