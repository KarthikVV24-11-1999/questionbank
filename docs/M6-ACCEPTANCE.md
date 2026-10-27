# M6 — acceptance, as it was earned

Six criteria were fixed when M6 began, with what could and could not be measured here. This is each one's verdict at close, and it is
the verdict the evidence earned, not the one the title of the criterion reads as. A `Partial` says what part. A `Fail — blocked` names the
resource that is missing and what would unblock it. The three the roadmap's criteria cannot be met without a device or a deployment stay blocked.

| # | Criterion | Verdict | What was proven | What was not, and what would unblock it |
|---|---|---|---|---|
| 1 | Zero response loss across 100 adversarial runs — network kill, process kill, device switch, clock skew | **Partial** | A hundred seeded runs in a real Chrome, 149 kills over 100 runs (59 tab crashes, 37 tab closes, 36 browser quits, 17 browsers killed once the write was on disk), 88 of them with events still unsent and 61 with everything acknowledged, every one with a question open, 991 responses given and 2,941 events on the server at the end. No response was lost in any of them. Clock skew: the wall clock shifted forward and back in 75 (48 back, 46 forward) runs changes nothing (nothing reads it), and the monotonic clock jumping forward, back and drifting is held in jsdom, where two defects were found and fixed (ADR-0041). | **Process kill is met for a tab that crashes or closes and a browser that quits, and for a browser killed once its write is on disk. It is not met for a browser killed outright inside Chrome's write delay with the server unreachable: the answer is lost (D66).** Network kill is exercised as a dropped connection at a stand-in server in 33 runs, not on a real network: blocked on a controllable network. Device switch: the server's union of two devices' events is proven (M6-33); the shell does not read the server's log back, so a second device starts empty (D68): blocked on real devices, and on that gap. |
| 2 | A full 3-hour mock completes on Android 9, 2 GB, 3G | **`Fail — blocked`** | What can be measured here is measured: the learner downloads **155 kB gzipped** (509 kB raw) and the signed package is at most 3 MB for a 75-item form (both gated). | The device and a 3G link. Unblocked by: an Android 9 / 2 GB handset on a throttled link, running the attempt for three hours (the same suite's scenarios can be played against it). |
| 3 | A complete backend outage mid-attempt loses nothing | **Partial** | Server side, against real Postgres: the outage is proxied, nothing is lost, and everything drains (M6-35). Client side, in a real Chrome: the app carries on through 503s and dropped connections in 91 (58 with 503s, 33 with dropped connections; some runs had both, so the two counts overlap) runs, every response stays on the device, the indicator says only what the engine's sync status says, and the queue drains when the backend is back. | **A tab reopened while the backend is still down cannot resume (D67)**: nothing is lost, but the learner cannot get at it until the backend returns. Unblocked by: a decision on resuming without the server (D67's trigger). |
| 4 | Memory ≤ 250 MB with no growth over 3 hours; battery ≤ 25% | **`Fail — blocked`** | Nothing is claimed. | The device. Unblocked by: the handset in row 2, instrumented for heap and battery over the three hours. |
| 5 | Answer keys absent from every payload (F6, F35) — blocking | **Pass** | Eleven surfaces, in [KEY-FREE.md](KEY-FREE.md): two static rules over the import graph, the contract, the package's bytes, every route's responses, the result, the relay's payloads, the learner's screens, and the learner's device in a real browser. Each has a test that shows the key absent and a test that shows the scan able to find one, and a check that the table still points at tests that exist. Three of the scans had no such control before this milestone closed; they do now. | — |
| 6 | Result available ≤ 60 s p95 after submission | **`Fail — blocked`** | The path exists and is exercised: submission writes its event in its own transaction, the relay delivers it, scoring writes a record, the student reads it. In-process, the scoring spec shows a result after one relay drain. | A deployment with a running scheduler and load to put a p95 on. Unblocked by: the first deployed environment (D36 says what is missing around the scheduler). |

> **Note, 2026-10-28 (M7 Track C).** Between M7-09 and M7-21 the spec that holds the server-side halves of rows 1 and 3 (the union of two devices' events, the outage
> that drains) was skipped (D73), and **row 5 rested in part on it**: the `attempt-responses` surface of the key-free argument pointed at two tests in that file, and
> the gate that reads the table could not see that they were not running. The row's standing was not earned over that interval for that surface. It is now:
> the two tests run, outside the skipped file, against the real controller, and the gate fails on a named test that is skipped. The spec is un-skipped, and its
> intermittent failure was not in the application (D73). Rows 1 and 3 keep the verdicts above.

**One passes, two are partial, three are blocked outright.** The headline criterion is `Partial`, and the loss that stops it being whole is real, small
and written down: it needs a browser killed with no warning, the server out of reach, and the kill landing in the few seconds of Chrome's own write delay.

## The adversarial runs, as measured

Seeds 20261026 to 20261125, played four browsers at a time; `QB_ADVERSARIAL_SEED=<n>` replays any one.

| Dimension | Runs exercising it | Where it ran |
|---|---|---|
| Tab crash | 59 kills | real Chrome |
| Tab close | 37 kills | real Chrome |
| Browser quit | 36 kills | real Chrome |
| Browser killed (SIGKILL) after the write is on disk | 17 kills | real Chrome |
| Kill with events unsent (mid-sync) / all acknowledged (between batches) | 88 / 61 | real Chrome |
| Backend 503 | 58 runs | real Chrome, stand-in server |
| Connection dropped | 33 runs | real Chrome, stand-in server |
| Wall clock shifted | 75 runs (48 back, 46 forward) | real Chrome |
| Deadline unmoved, no attempt request in any cache, device projection equal to server projection | all 100 | real Chrome |
| Monotonic clock forward, back, drift; outage and drain | session specs | jsdom |
| Browser killed with no wait, server unreachable | a characterisation, not a run: the answer is lost | real Chrome (D66) |
| Tab reopened during an outage | a characterisation: it cannot resume | real Chrome (D67) |

Every kill landed with a question open, because the screen always has one: a kill between questions is not a thing this interface can produce.

## The register at close

D57, D58, D59, D61 and D62 are open with their triggers intact (D59's text now says what the signature does not protect against). D63 is
restated: the learner's path is through assessment and is proven on the server; the scoring route's own defect stands. D64 (a window closing does
not submit running attempts) is open and a product decision. D65 (the unexplained flake) did not recur in the runs of this track. New: **D66**
(a browser killed outright loses what was in its write delay), **D67** (a tab reopened during an outage cannot resume), **D68** (the shell does not
read the server's log back, so a second device starts empty) and **D69** (the development token in `localStorage`, to go at M8).
