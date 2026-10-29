# @questionbank/adversarial

The adversarial suite for the learner app (M6-53 to M6-57): a real Chrome is started, driven through the learner's own controls,
killed, restarted and reopened against the built `apps/learn` bundle, with the network and the wall clock made to misbehave, while a plain
map of what the learner did is held beside it as the oracle. A hundred seeded scenarios; a response the learner gave must never be
missing afterwards.

## What runs where

| Dimension | Runs in | Notes |
|---|---|---|
| Tab crash, tab close, browser quit | **Real Chrome**, real `localStorage` on a real profile | `Page.crash`, `page.close`, `Browser.close` |
| Browser killed (`SIGKILL`) | **Real Chrome** | only once the write is on disk; a kill that does not wait loses it (D66), see `known-gaps.spec.ts` |
| Backend down (`503`) and connection dropped | **Real Chrome** against `src/stub-server.ts` | not the API: it speaks the contract's shapes and keeps events in memory |
| Wall clock shifted forward and back | **Real Chrome** (`Date` is replaced in the page) | nothing in the app reads it, which is what is being shown |
| Monotonic clock jumping or drifting | jsdom, in `apps/learn/src/session/adversarial.spec.ts` | a browser's monotonic clock cannot be moved on demand |
| Service worker | **Real Chrome**, `src/service-worker.spec.ts` | also run once more inside every adversarial run |
| Network kill on a real network, device switch | **not run** | need real devices and a controllable network |

## Reading a failure

Every run is a function of its seed. A failure prints `replay with QB_ADVERSARIAL_SEED=<n>` and the scenario's steps; running that
seed alone (`QB_ADVERSARIAL_SEED=<n> corepack pnpm --filter @questionbank/adversarial test`) replays it. `QB_ADVERSARIAL_TRACE=1` prints
each step; `QB_ADVERSARIAL_RUNS` and `QB_ADVERSARIAL_WORKERS` change the count and the number of browsers.

A run that times out also leaves what the page did, in `tools/adversarial/failures/seed-<n>/`: `console.log`, `network.log`, `screenshot.png` and
`summary.json` (what the page was showing, whether the worker controlled it, the keys it held). CI uploads that directory as the `adversarial-failures`
artifact; read `summary.json` first (D80).

No test sleeps for a duration. Every wait is for a condition (a record holding an event, the status saying all is sent, a file holding
the bytes) with a timeout that only turns a condition that never comes true into a failure.

## Chrome

The suite needs Chrome and does not skip without it: it looks at `CHROME_PATH`, the usual macOS and Linux locations, and fails with what
it looked for. The runner for CI has one installed. No browser is downloaded.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # builds apps/learn, then runs the suite (about two minutes)
```

`negative-controls.spec.ts` plants four defects (a device that forgets, a server that drops events, a server that restarts the deadline,
a cache that holds attempt requests) and requires the run to fail on each; a harness that cannot fail would prove nothing by passing.
