# ADR-0012 — The Learn shell is deferred to M6
Status: Accepted
Date: 2026-08-14

## Context

ROADMAP names "Learn and Studio app shells" under M0. There is no `apps/learn` in this repository, and
[M0-WALKING-SKELETON.md, DEC-M0-6](../tasks/M0-WALKING-SKELETON.md) recorded the recommendation to defer it
when the milestone's task breakdown was ratified. This ADR is that decision's permanent record, written at
M0-27 close-out per DEC-M0-6's own instruction.

## Decision

**Not in scope for M0**, for three reasons, in order of weight:

1. ROADMAP's own sequencing rule 1 states M1 through M5 ship no student-facing feature — a Learn shell would
   have nothing to render until M6 and would sit unused for five milestones.
2. Learn is a PWA whose defining pieces — the service worker, the offline attempt engine
   (`packages/attempt-engine`, F26's subject, still not built — M0-25) — are not this milestone's to build
   and are not buildable on this machine regardless.
3. M0's own acceptance is one authenticated request end to end, which Studio already had a shell for
   (M3-39) and Learn does not. Building a second shell to prove the same walking skeleton would have been
   redundant work spent proving something Studio already proves.

**Trigger: M6's first task.** When Learn's own milestone begins, this ADR is what a reader checks to
understand why M0 shipped one shell, not two.

## Consequences

**Makes easy:** M0 stayed inside its own scope — one composed application, one client surface wired end to
end (Studio's Item Browser, M0-19) — rather than splitting effort across two shells neither of which needed
to exist yet.

**Makes hard:** F26 (the attempt engine imports no framework) and F24 on Learn's own token layer have no
subject in M0. F26 is handled at M0-25 as `Pass (rule proven) / no subject`, not reported green over an
empty set.

**Forecloses nothing.** Nothing about the composed application (`createApplication`, M0-12) or the typed
client (`packages/contracts/src/client.ts`, M0-17) is Studio-specific — Learn's shell, when M6 builds it,
consumes the same composed API and the same generated client Studio already does.

## Alternatives

**Build a minimal Learn shell now, mirroring Studio's `index.html`/`main.tsx`/build.** Rejected: it would
have nothing to route to (no attempt engine, no offline story) and would only prove the same "an app can
mount and hit the API" fact Studio's M0-15 through M0-19 already prove, at the cost of a second Vite
project, a second `vite.config.ts`, and a second entry-point spec — all authored against a feature this
milestone's own scope boundary places at M6.
