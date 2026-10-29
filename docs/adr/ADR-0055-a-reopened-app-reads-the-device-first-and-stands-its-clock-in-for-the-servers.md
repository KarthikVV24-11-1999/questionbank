# ADR-0055 — A reopened app reads the device first, and stands its own clock in for the server's when the server cannot be asked

**Status** Accepted · M7 Track H2, M7-56 · Part-closes D67 (a reopened tab resumes offline once the service worker holds the package; a first visit alone leaves none, and D67 stays open for that) · Refines the resume of [ADR-0039](ADR-0039-the-learner-shell-is-a-view-of-the-engine-and-verifies-what-it-shows.md)

## Context

`boot` fetched and verified the package, then read the device's record of the attempt, then asked the server for the attempt to take its deadline afresh. The device's record is the one thing that
survives an outage and holds every answer the learner has given, and it was read after two awaited network calls and used only if a third succeeded. A tab reopened while the backend was down
therefore showed nothing, in exactly the condition the record exists for. The service worker serves the package and its key from its cache when the network is down, and never an attempt. (It has them only for a page it controlled: see the correction at the end.)

The package rule is not in question and does not move: nothing is created, started or shown on a paper nobody vouched for.

## Decision

**The record is read first, before any request.** The package and key are then fetched and verified as before, and the verdict comes before anything else is done with the record. A record is
carried on only against a paper that verified and whose form is the one the record names; the record now says which form it is of.

**When the server cannot be asked, the device's clock plus an offset stands in for the server's.** The offset is the server's reading of its clock minus the device's wall clock, taken at every
contact and kept in the record. The deadline is the one the record wrote down, which the server fixed at the start. The time left is computed once, at resume, against the wall clock moved by the
offset; from then on the timer runs on the monotonic clock as it always has. "Cannot be asked" is a request that fails to connect or a server that answers 5xx. A server that answers and
refuses is a refusal, not an outage, and surfaces as it did. A record that does not name its form or hold an offset (one written before they were kept) is not resumed offline.

**The server re-validates at submission, and that is what makes the stand-in safe.** The stand-in is wrong exactly as far as the device's wall clock moved between the last contact and now, and
it can be wrong in two directions, with different consequences:

- *Behind real time* (the learner sets the clock back, or it drifts): the app believes more time remains than does. The learner keeps answering past the real deadline, and the server records
  those events as late and does not score them. The error is ignored; the server's deadline decides.
- *Ahead of real time*: the app believes less time remains and submits at what it thinks is the deadline. The server refuses an expiry sent before its own deadline and the submission is retried,
  but the log on the device is closed meanwhile, so the learner loses the difference. This is the direction in which it is wrong in the learner's disfavour, and it is bounded by what the wall clock
  did since the last contact, not by anything the learner did.

Neither direction lets a learner gain marks, which is the property the offset has to have.

## Consequences

- The offset is refreshed at every contact, so the window in which a wrong wall clock can matter is the time since the last contact, which is the time the server was unreachable.
- Nothing about D66 changes: a browser killed outright still loses what it had not yet written to disk, and that wants real-device evidence.
- The attempt route now returns the log (DEC-M7-29), so a device that holds no record at all continues from the server's, which is the other half of resuming and does not need a clock.

## Correction after a real-Chrome run

The decision stands and the part it assumed was wrong. The unit tests gave `boot` a package during the outage, as the worker is described to do, and the entry was closed on that. In a real Chrome the worker
caches the package only for a page it controls, and it does not take over the page that installed it, so a first visit that is never reloaded leaves the shell in the cache and no package. The reopen then has no
paper to verify and, rightly under the rule above, shows nothing. `known-gaps.spec.ts` holds both halves: the resume with the package cached passes, and the first-visit case is held open. D67 stays open for the second.
