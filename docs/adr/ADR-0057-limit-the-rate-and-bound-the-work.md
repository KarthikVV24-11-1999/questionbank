# ADR-0057 — Limit the rate, and bound the work

**Status** Accepted · M8 Track B, M8-06 to M8-10 · Closes D94 (docs/DEBT.md)

## Context

Track A left the authentication routes open to anyone as fast as a connection allowed. NFR SEC-09 asks for per-identity and per-source limits, verified by an abuse simulation. The brief for this track warned that
a rate limiter limits how often, not how many at once, and that a login holds about 64 MiB for a few hundred milliseconds. Measured, the second half is smaller than it read: scrypt runs on libuv's thread pool, four threads by
default, so 200 derives started together peaked at about 259 MiB and took 7.7 s; the pool, not the request count, is the ceiling on memory (about a gibibyte if someone sets `UV_THREADPOOL_SIZE` to 16). What a flood does is
occupy every thread for as long as it takes, so file, DNS and compression work queues behind it, and let a queue grow without a bound. That needs a bound of its own, and the limiter does not provide it.

## Decision

**A limiter behind a port, two adapters.** Fixed windows in two tiers (a burst and a sustained rate), counted by one atomic upsert per hit. A token bucket would smooth the edges at the cost of a fractional balance read and
written together; here the doubling at a window boundary is bounded by the other tier, and the retry time is exact. The Postgres adapter serves the authentication routes: the round trip is nothing next to a derive and the
limit is the same from every instance. The in-memory adapter serves routes asked too often for a round trip each, and counts per process (D97, docs/DEBT.md). Counters live in their own schema, because everything in `platform` is
append-only for the application role by rule and a counter is the opposite.

**Both counters, before the handler.** A request is counted against its source and its subject, always both, before anything that costs. A limited request has looked up no address and derived nothing, so it cannot tell a known address from
an unknown one (DEC-M8-3, docs/IMPLEMENTATION-DECISIONS.md). A held address is held for at most the longest window of its policy, not for longer after each failure.

**A bound under the thread pool.** Every derive, the hash that makes a credential and the verify that checks one, takes a turn at a bound of two in flight with a queue of 256 and a wait of fifteen seconds. Two leaves half the pool
for everything else; a hundred students logging in at once are all through in about eight seconds and none is refused. A full queue answers 503 with `Retry-After`, the same for every caller. The bound wraps the hasher, so a handler written later
is bounded the day it is written.

**What a limited request gets.** 429 in the problem-details shape every refusal has, with `Retry-After` and nothing about the limit's state. One log record, with the code `RATE_LIMITED` and the reason as an attribute, which an operator can tell
from a refusal's code; no address or network address appears in it. No analytics event: none is in the catalog, and adding one is not this track's to do.

**Contexts keep to their ports.** Identity declares the shapes of the limiter and the bound it asks for, and the composition root hands in the platform's implementations (ADR-0026: a context reaches `platform/` for the role vocabulary and nothing
else). A spec assigns each of the platform's to each of identity's.

## Consequences

**Makes easy:** a new route is limited by naming a policy; the policies are configuration and a deployment that gets one wrong fails to start. The abuse simulation runs the pair that matters, a burst refused and a school served, in one file.

**Makes hard:** limits are numbers someone has to choose, and these are reasoned, not measured against real traffic. Search, export, reporting and AI endpoints are not limited yet (D98). The bound is sized by hand against a thread pool it does not own (D99).

**Not built here:** account lockout with unlock by mail, a shared counter for the in-memory adapter, limits on routes outside authentication.
