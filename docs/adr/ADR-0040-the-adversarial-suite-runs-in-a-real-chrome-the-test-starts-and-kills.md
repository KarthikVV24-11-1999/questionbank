# ADR-0040 — The adversarial suite runs in a real Chrome that the test starts and kills

**Status** Accepted · M6 Track H, M6-53 · Sets what "process kill" means for the zero-response-loss criterion

## Context

The roadmap's reliability criterion is zero response loss across a hundred adversarial runs: network kill, process kill, device switch and
clock skew. `apps/learn` was tested in jsdom, with a fake transport and an in-memory storage shim, and nothing in the repository could run a
browser. Two of the dimensions are fine there. Clock skew is injected through a port the engine already has. A backend outage is a fake
transport that throws. **Process kill is not**: jsdom runs inside the test process, so killing it kills the test, and against a storage shim
"the process died and was reopened" is the discarding of an object. That exercises the logic of the restore path and says nothing about whether a
browser kept what the learner did — which is what the criterion is about.

Counting a hundred jsdom runs as that dimension met would have been the one place in this milestone that took the easier evidence: everything else
here is held to a real Postgres, real triggers and a composed application.

## Decision

**A real browser is added, and process kill runs in it.**

- **Which.** Chrome, the one the learner's phone runs, driven over the DevTools protocol by `playwright-core` — the library only: no test runner, no
  browser download, no bundled browsers. The test starts Chrome itself as a child process with its own profile directory (`tools/adversarial/src/chrome.ts`)
  and attaches over CDP, so a kill is a signal to the browser's own process and the profile on disk is all the next launch has. Chrome is already on the
  CI runner, and on a developer machine the suite finds it (`CHROME_PATH`, then the usual locations) and **fails, not skips,** when it cannot: a skipped
  test blocks the task.
- **Where.** `tools/adversarial`, a workspace project with its own `test` and `typecheck`, in its own CI job. It builds `apps/learn` (with
  `NODE_ENV=production` set explicitly, because a test runner sets `test` and a build under that name bundles the development copy of React) and
  serves that build, with a small server that speaks the assessment contract's shapes, from the same origin the page calls. The server is **not the
  API** and the suite says so: what it can show about the server is what a client was acknowledged for, which is the right thing to hold a client to and
  the wrong thing to claim anything about the API with. The API's half is proven against Postgres in `apps/api`.
- **What dies, and how.** Four kinds of death, each a different thing: a **tab crash** (`Page.crash`, the renderer is killed with no unload — the way an
  out-of-memory tab dies); a **tab close** with no `beforeunload`; a **browser quit** (`Browser.close`, Chrome's orderly shutdown); and a **browser killed
  outright** (`SIGKILL`). The fourth is exercised in the hundred runs only **once the write is on disk** (the run waits, as a condition, for the bytes to
  appear in the profile), because a kill that does not wait is a finding and not a pass — it loses what was written in Chrome's own write delay when the
  server does not have it (debt D66), and `known-gaps.spec.ts` says so in a test that goes red the day the loss closes.
- **Where each dimension runs.**

  | Dimension | Runtime |
  |---|---|
  | Tab crash, tab close, browser quit, browser killed after the write is on disk | real Chrome, real `localStorage`, real profile |
  | Backend down (503), connection dropped without an answer | real Chrome, against the contract-shaped server |
  | Wall clock shifted forward and back | real Chrome (`Date` replaced in the page): nothing reads it, which is the claim |
  | Monotonic clock jumping forward, back, drifting | jsdom with the clock port, in `apps/learn`: a browser's monotonic clock cannot be moved on demand |
  | Service worker | real Chrome |
  | Network kill on a real network; device switch across devices | **not run**: a controllable network and real devices |

- **Seeds.** A scenario is a function of its seed and nothing else (`prng.ts`, `scenario.ts`: no clock, no `Math.random`). Seeds are
  `20261026 … 20261125`; a failure prints `QB_ADVERSARIAL_SEED=<n>` and the scenario, and running that seed alone replays it. Runs are played by four
  browsers at a time; a seed's outcome does not depend on which browser plays it or what plays beside it.
- **Flakiness.** No test sleeps for a duration. Every wait is for a condition with a timeout that turns "never" into a failure, and the one place a
  wait is long (waiting for the write to reach the disk) is a poll of the files, not a sleep. A flaky adversarial suite is worse than an honest gap
  because it trains people to rerun, so the two places where Chrome's own timing is the subject are written to be deterministic by construction: the
  loss test looks at the disk after the kill and counts only a kill that left the answer off it.
- **The harness is shown to fail.** `negative-controls.spec.ts` plants four defects — a device that does not write its responses down, a server that
  drops what it is sent, a server that restarts the deadline when the attempt is read, a cache that holds attempt requests — and requires the run to fail on
  each, with what it found.

## Consequences

**Makes easy:** the criterion that is the headline of the milestone is measured against a browser's own storage. It found two defects in the shell
that jsdom could not have (a forward jump of the monotonic clock locked the learner out; a question left open across a restart could be credited with
the time the app was dead — ADR-0041) and two gaps that remain (D66, D67).

**Makes hard:** the suite takes about two minutes and needs Chrome. The server it runs against is a stand-in, so nothing here is evidence about the API's
side of an outage or a device switch.

**Does not change** what stays blocked: a real network, real devices, three hours on an Android 9 phone.

## Alternatives

**Count a hundred jsdom runs.** Rejected, above.

**Playwright's test runner and its downloaded browsers.** Rejected: a second test runner beside vitest, a browser download in an environment that may
have no network, and the browser this repository would test would not be the one a learner runs. The library over CDP gives the control needed (the
process is ours) with none of that.

**An Android emulator.** Rejected here: it is the right tool for the memory and battery criteria and for the 3G profile, and needs a machine and an image this
repository does not have. It is named as what would unblock those rows.
