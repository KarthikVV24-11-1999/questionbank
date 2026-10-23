# ADR-0039 — The learner shell is a view of the engine, and verifies what it shows

**Status** Accepted · M6 Track G, M6-46…M6-51 · Closes the deferral in [ADR-0012](ADR-0012-the-learn-shell-is-deferred-to-m6.md)

## Context

ADR-0012 deferred the Learn shell to M6 because its defining pieces — a signed package, an attempt engine, a server deadline, an
offline queue — did not exist. They do. The risk in building the shell now is the one this project keeps paying for: a UI that
grows its own copy of what another module already answers. Three copies were foreseeable — the answers on screen, "am I online",
and "how much time is left" — and each would be a second source that disagrees with the first on exactly the day a learner loses
connection.

## Decision

**`apps/learn` is a workspace project (`@questionbank/learn`)** with its own `test`/`typecheck`/`build`, in CI's unit and build jobs.

**The engine owns the attempt; the shell draws it.** `session/attempt-session.ts` is the one module that calls the engine; components
read the session through `useSyncExternalStore` and send intents to it. A fitness rule (`learn-rules.ts`) holds this mechanically:
component state only in two named files and never under an attempt's name; no browser storage, wall clock, timer or connectivity
check outside the host file `main.tsx`; no value import of the engine outside `session/`.

**The client verifies before it renders.** The package is verified over its exact bytes with the public key from the signing-key
route; a package without a signature, with a key id that does not match, or whose signature does not verify is refused and nothing
is parsed from it. The shell never decides a cached package is good — it verifies on every open, from the cache as from the network.

**The indicator is the engine's `syncStatus`.** No `navigator.onLine`. The browser's `online` event only asks the session to try the
queue now.

**The deadline is the server's, and expiry is a reason.** The attempt response gives the deadline; the shell derives the remaining
time from the engine's monotonic timer over it, so sleeping or reloading cannot extend it. A reload re-reads the attempt and resumes
against the same deadline. At zero the shell submits with reason `expiry`; the server still distinguishes that from a late `manual`.

**The service worker caches the shell and the package, and never an attempt.** It does not answer `/v1/assessment/attempts…` at
all (no `respondWith`), so a failed event is a failed request that the app's own queue retries. It never takes over an open page
(no `skipWaiting`, no `clients.claim`): a stale shell against a newer package is refused by the app with an instruction to reload and
a request to the registration to look for a new shell; a new shell waits for the old tabs to close, so an attempt in progress is never
swapped.

**The server says `no-store` on every assessment response** and `private, no-cache` on the package, so a shared cache cannot hold an
event either.

## Consequences

**Makes easy:** a UI change cannot quietly become the source of truth; the invariant fails a gate instead of a learner.

**Makes hard:** a component that genuinely needs local state must be added to the allowlist, a reviewed diff with a stated reason.

**Not proven:** nothing drives the real service-worker lifecycle or a real server through the shell; jsdom and a `vm`-hosted worker
stand in. Browser-driven journeys are M8's.

## Alternatives

**A client-side store for responses with the engine as a sync target.** Rejected: that is two sources by construction.

**Cache attempt reads for offline resume.** Rejected: the device's own log already resumes the attempt, and a cached read is a stale
deadline.
