# Handoff — M0 in progress, M0-01 through M0-19 merged, green at HEAD

**State as of 2026-08-13, HEAD `feb555a`.** **19 of 27 tasks merged.** Track A (ground), Track B (the
composition root) and **all of Track C (Studio as an application)** are complete. **D3 is closed.** Track D
(authored infrastructure — Compose, CI, Terraform) and Track E (gates and close-out) have not started.

Supersedes [HANDOFF-M0-RESUME-3.md](HANDOFF-M0-RESUME-3.md) and every earlier handoff.

---

## Is D3 closed? **Yes.**

D3 was "the half DEC-5 deferred: an entry point and a build" for Studio. `apps/studio/index.html` +
`main.tsx` + `vite.config.ts` exist, `corepack pnpm --filter @questionbank/studio build` produces a real
`dist/` (proven by `build.spec.ts`, which runs Vite's own build API, not a re-assertion of the config's
source), navigation is real over the History API (`useRoute`, M0-16), and one surface — the Item Browser —
is wired end to end against the real composed API, not a fake (M0-19). The `StudioShell.spec.tsx` test that
used to assert *no* entry point existed under DEC-5 is rewritten to assert one does, per M0's own rule
against a test left asserting a falsehood.

**What is still true, and named rather than hidden:** only Authoring is wired live; Taxonomy and Exams &
Forms still render nothing when navigated to, on their existing in-memory-model feature components — wiring
them was never this milestone's scope. The Item Editor's own commands are unwired — that is **D29**,
recorded at M0-19's own task entry, and it is what stands between here and M3's ≤ 20 min criterion
(DEC-M0-12).

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Both run clean, exit 0. Full workspace, this session's final check:

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 144 | **3442** |
| `apps/studio` | 16 | **272** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 2 | **10** |
| `packages/domain-types` | 1 | **2** |
| `tools/seed` | 5 | **94** |

`pnpm -r typecheck` clean across all 6 typechecked projects. Working tree clean at HEAD except
`apps/studio/bundle-size.json`, which is expected to move on every `build.spec.ts` run (it is the
close-out's own measurement file, not stale state).

---

## What landed this session (M0-15 → M0-19)

### The two things owed from the previous session

1. **Grep for the ADR-0017 construction-time-context shape in curriculum/content.** All ten repositories in
   both contexts take only a `Pool`/`NodePgDatabase` — nothing else. **No second instance found**, matching
   last session's result exactly.
2. **`docs/tasks/M0-PROGRESS.md` gained a line recording that commit `6d9c697`** ("docs: log M0-12
   completion") accidentally carries M0-13's source files in its diff. Content is correct; only that one
   commit's label is wrong, and it is not being rewritten. Flagged explicitly so the close-out does not
   claim otherwise.

### M0-15 — `index.html`, `main.tsx`, Vite config & build, closes D3

`vite@7.3.6` and `@vitejs/plugin-react@4.7.0` resolved from the offline store as named. `main.tsx` mounts
`StudioShell` and, at landing, nothing else. `vite.config.ts` strips source maps in production. The build
spec runs Vite's own `build()` API rather than re-parsing the config, asserting `dist/index.html`, exactly
one hashed JS bundle, and zero `.map` files. Initial bundle measured and written to
`apps/studio/bundle-size.json` (currently ~398 KB) — no per-route budget invented, per the task's own
instruction, since no route split exists yet.

### M0-16 — Navigation over the History API

`useRoute` (`shell/use-route.ts`) wraps `window.history` — `pushState` on navigate, `popstate` on
back/forward — over the existing typed route table, reporting an unmatched path as
`activeDestinationId: null` rather than a fallback guess. Not a router (D30): no dependency beyond `react`
and `./navigation.js`, asserted by reading the file's own import list. Two real jsdom timing issues found
and fixed while proving it, not padded around: `history.back()`/`forward()` fire `popstate` asynchronously,
and the focus-on-navigation assertion had to blur the heading first, since `StudioShell` already moves focus
on the initial render.

### M0-17 — The typed HTTP client, F15's subject

`packages/contracts/src/client.ts`. `createClient` is a thin `fetch` wrapper typed entirely from the
generated artifacts — content's Zod schemas validate every response at the boundary (an unexpected shape is
a thrown `ResponseSchemaError`, never a cast), and a non-2xx response with a problem-details body becomes a
typed `ApiProblemError`. **Found and fixed a real bug while writing the test for a genuinely non-JSON error
body**: `JSON.parse` on a malformed response threw uncaught instead of becoming `UnparseableErrorResponse`.
F15 itself now lives in a new `apps/api/src/fitness/frontend-rules.ts` (scans the **repository root**, not
the API project root — the first fitness file to reach outside `apps/api` on purpose), proven red against a
planted `fetch(` call in a fixture, and proven to have actually scanned real source (>20 files).

### M0-18 — Studio design tokens & F24

`apps/studio/src/tokens.ts` mirrors `content-renderer`'s token layer (mirrored, not imported — M3-01's
`Result` argument). F24 extends `frontend-rules.ts`: hex/`rgb()`/`rgba()`/`hsl()` scanned blanket, CSS named
colours scanned **only inside a colour-property context** (`color: 'crimson'`, never a bare word) — a
blanket word scan was rejected outright, because this repository authors JEE/NEET chemistry and physics
content where "gold foil experiment" and "silver nitrate precipitate" are correct prose, not a colour
literal; a fixture proves that prose does *not* trip the check. No component migration was needed: a grep
before writing the check found zero literal colours anywhere in `apps/studio/src` — every surface styles
through `className` alone today, no stylesheet yet authored.

### M0-19 — One surface wired end to end

The Item Browser. `item-browser-api.ts`'s `createLiveItemBrowserApi` wires the list query through M0-17's
client to the real `ListMyDrafts` endpoint. Loading, empty and error states all render — `ItemBrowser.tsx`
gained the error state it never had, reading only a problem's `title`, never a raw message. URL filters
still round-trip after wiring.

**Two real, narrower-than-the-port gaps, named as debt rather than hidden:**

- **D33** — `subject` and `conceptIdentityId` have no source on the one real listing endpoint
  (`ListMyDrafts` returns `AuthoringItemView`, which carries a concept tag, not a subject name); both
  filters are client-side no-ops in the live adapter. Trigger: a curriculum concept → subject lookup lands
  (echoes D23), or content exposes one directly.
- **D34**, found independently while proving this against the real API rather than assumed clean:
  `CreateItemDraftHandler` (`apps/api/src/contexts/content/application/handlers/authoring-handlers.ts`)
  returns the raw domain `Item` aggregate — `authoredBy` (a full `PrincipalRef`) and an undocumented
  `aggregateVersion` field — instead of `toAuthoringItemView(item)`, diverging from `content.yaml`'s
  documented `AuthoringItem` response. `GetItemDraftHandler` and `ListMyDraftsHandler` both go through the
  view and are unaffected; this is scoped to command handlers that echo what they just wrote. **Out of
  scope to fix in M0-19** — it touches every authoring command handler, not one. The live-wiring
  integration test works around it by using a plain `fetch` for setup rather than the strict typed client.

**A separate real defect, fixed as a prerequisite before M0-17/19 could be proven honest:**
`ListMyDraftsHandler` returned a bare array on the wire; `content.yaml` documents `AuthoringItemPage`, an
`{ items: [...] }` wrapper the generated Zod schema (D18) already expected. No client had ever validated the
real response against the generated schema until this session. Fixed in the handler, matching the document
(commit `3334343`).

**The real end-to-end proof** lives at
`apps/api/src/contexts/content/item-browser-live.integration.spec.ts`, importing Studio's own live client
directly into `apps/api`'s integration project. This is the one dependency direction in the repository that
runs from `apps/api` toward `apps/studio` (a `devDependency`, test-only), and it exists because the other
direction does not type-check: `apps/studio` importing `createApplication` would pull NestJS's
`experimentalDecorators`/`emitDecoratorMetadata` requirement into a tsconfig that neither has nor should
have it, and a single `tsc` program cannot check the same file two different ways. `item-browser-api.ts` and
`item-browser-model.ts` need nothing from React or JSX, which is what makes the chosen direction safe — one
`/// <reference lib="dom" />` was added to `item-browser-model.ts` so its one DOM-touching export
(`browserSearchParams`, unrelated to this test) still type-checks under `apps/api`'s DOM-less `lib` list.
Both files' headers record the reasoning.

---

## A decision surfaced and not answered mid-session

Before M0-17, a genuine pre-existing contract/implementation divergence was found (the `ListMyDrafts`
wrapping bug above) and a clarifying question was asked via the question tool. **No answer arrived
synchronously**, so the session proceeded with the tool's own labelled recommendation — fix the handler to
match the document, since D18 makes the document authoritative — rather than stall. Worth confirming this
was the right call before it is relied on further; nothing downstream depends on it being reversible only
with difficulty (it is a one-file, well-tested change).

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) | **The entries for M0-20 through M0-27** — Track D (authored infra) and Track E (gates and close-out). You already know 01–19 |
| [tasks/M0-PROGRESS.md](tasks/M0-PROGRESS.md) | One sentence per task, in order |

---

## Where to resume: M0-20 (Track D — Compose stack & the spec that parses it)

Not started. `infra/compose/` does not exist. M0-20 through M0-23 are Track D, **Tier 2 throughout**
(DEC-M0-1) — every assertion is over a file's parsed content, none of it claims a runtime property, and each
task must name its Tier-3 successor command verbatim. Read the M0-20 entry fresh; it names its own new ADR
(**ADR-0013**) and an amendment to ADR-0004.

**Track E** (M0-24 through M0-27 — the `questionbank_app` role closing D9, the gate register, close-out)
remains entirely unstarted.

---

## Conventions this session reinforced

1. **A real defect found while proving a task honest gets fixed and recorded, not routed around** — three
   separate instances this session (the `ListMyDrafts` wrapping bug, the `JSON.parse` crash in the client,
   the `CreateItemDraftHandler` view-bypass), each with its own commit or its own named debt item, matching
   the pattern M0-09/M0-11/ADR-0017 set last session.
2. **A port narrower than its interface is named in the adapter's own header, not discovered by a future
   reader.** D33's subject/concept no-op is documented exactly where the gap is, the way W4 and INV-08 were
   documented for the in-memory doubles.
3. **Cross-package test dependencies pick the direction that type-checks, and say why.** Two directions were
   tried for M0-19's real-API proof; the one that works is recorded in both files' headers so nobody
   "fixes" it back to the broken direction later.
4. **A jsdom timing quirk is diagnosed from its exact error, never padded around with a longer sleep.** Both
   `use-route.spec.tsx` and `main.integration.spec.ts` (last session) found their fix by running red first
   and reading why.
5. **A failing or skipped test blocks the task. No quarantine.** Held without exception — every new test
   this session is green in the final full run.

---

## Environment

Unchanged from [HANDOFF-M0-RESUME-3.md](HANDOFF-M0-RESUME-3.md). Postgres on 5433, `corepack pnpm`, no
network. `apps/studio` now has two vitest environments in play: the default `jsdom` project for components,
and a per-file `// @vitest-environment node` override (`build.spec.ts`) for the one spec that runs Vite's
own build — esbuild does not work under jsdom's `TextEncoder`.

---

## What still does not exist

- **No Compose boot, no CI run, no Terraform plan.** Track D untouched; F8 stays `Fail — blocked`.
- **No `questionbank_app` role landed locally.** D9 still open, Track E's to close (M0-24).
- **No review workspace.** Still M4, untouched.
- **No validated golden set.** B1 still open. Golden set unchanged: **40 pass, 0 official papers, 4
  synthetic** — nothing this session touches the executor's rule computation.

---

## Carried forward

### B1 — blocking gate, still open

Unchanged. **Do not attempt to source papers.**

### Debt

**New this session:** D33 (Item Browser's subject/concept filters have no source on the real listing
endpoint), D34 (`CreateItemDraftHandler` echoes the raw domain aggregate instead of its documented view).

**Unchanged:** D19–D21, D22 (closed), D23–D26, D27 (closed), D28, D29 (Item Editor unwired, named at
M0-19's own task entry), D30 (`useRoute` is not a router), D31, D32. **D3 is closed this session. D9 remains
open** — M0-24's, still unstarted.
