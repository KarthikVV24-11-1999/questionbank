# @questionbank/learn

The learner's exam shell (ASSESSMENT-ENGINE §7): one paper, chrome-less — no site navigation, no link out, the only way off the page is
to submit. It is a **view of the attempt engine**, not a second owner of the attempt: every answer, flag, visit, the timer and the sync
queue live in `@questionbank/attempt-engine`, and the shell draws what the engine says.

## What it does

- **Opens a signed paper.** `GET /v1/assessment/forms/{id}/package` returns the exact bytes the server signed; the shell verifies the
  Ed25519 signature (WebCrypto) against the public key **before parsing**. A tampered, unsigned or unverifiable package is refused, and
  no item is rendered from it (`src/package/`).
- **Runs the attempt on the engine.** `src/session/attempt-session.ts` is the only module that calls the engine. The interval cap is
  read from the attempt response, never chosen (ADR-0037).
- **Works offline.** Every event is written to the device first, then queued for the server. The sync indicator shows the engine's own
  `syncStatus` and nothing else — calm, never an alarm.
- **Submits on the deadline.** The deadline is the server's, fixed at start; a reload resumes against it. At zero the shell submits with
  reason `expiry`.
- **Is a PWA.** `public/sw.js` — see the header of that file for what it caches and what it never does. In short: the shell and the
  signed package (and its key) are cached; **anything under `/v1/assessment/attempts` never is**, and the worker does not even answer
  those requests.

## What it must not become

The rules in `apps/api/src/fitness/learn-rules.ts` (run in the fitness job) hold the shell to this, with committed planted violations
that have been seen red:

| Rule | What it forbids |
|---|---|
| `M6_47_STATE_OUTSIDE_THE_ALLOWLIST` | component state (`useState`, `useRef`, a store library…) outside two named files |
| `M6_47_ATTEMPT_NAMED_STATE` | state under an attempt's name, even in those files |
| `M6_47_STORAGE_OUTSIDE_THE_HOST` | browser storage outside `main.tsx` |
| `M6_47_ENGINE_VALUE_IMPORT_OUTSIDE_THE_SESSION` | calling the engine from a component |
| `M6_49_CONNECTIVITY_OUTSIDE_THE_HOST` | a second notion of "online" |
| `M6_50_AMBIENT_TIME_OUTSIDE_THE_HOST` | the wall clock or a timer outside the host |

F15 (no hand-written `fetch`) and F24 (no colour literal outside `src/tokens.ts`) cover this project too.

## How to run it

```bash
corepack pnpm dev     # Vite dev server; open /?form=<formId>&session=<sessionRef>
corepack pnpm build   # production build — no sourcemaps; public/sw.js is copied as it stands
```

There is no login UI yet (sign-in is M8's): as in Studio, set `localStorage['qb-dev-token']` to a bearer token.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest + jsdom, with coverage
```

Coverage: 100% on `session/attempt-session.ts`, `session/persistence.ts`, `package/verify.ts` and `package/load.ts`, which decide what an
attempt is and what may be shown; the components are held by behaviour tests and an axe scan. Everything runs in jsdom; no browser-driven
suite exists yet (M8), so the real service worker lifecycle and a real server are **not** driven end to end by anything here.
