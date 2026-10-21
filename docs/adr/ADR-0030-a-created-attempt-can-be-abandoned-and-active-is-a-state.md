# ADR-0030 — A created attempt can be abandoned, and "active" is a state, not a clock reading

**Status** Accepted · M6 Track B, M6-09 · Amends ASSESSMENT-ENGINE §5 · Closes D53

## Context

ASSESSMENT-ENGINE §5 draws `created → in_progress → abandoned`, so `abandoned` is reachable only from
`in_progress`. The attempt state machine in `packages/attempt-engine` implemented that faithfully, and in
doing so exposed the gap D53 recorded: an attempt whose package was downloaded and which the student never
began stays `created` for good.

That collides with the same section's integrity rule, **one active mock attempt per student**. If a
`created` attempt is active, a student who opens a mock and walks away can never start another one. The
rule that exists to remove ambiguity creates it.

D53 named two repairs: an `abandon` edge from `created`, or a rule that a `created` attempt past its window
is not active. The task document's reading was that the edge is the smaller, truer fix. This ADR checked
that reading and agrees, for a reason beyond the one given.

## Decision

**`created` has an `abandon` edge, and "active" means `created` or `in_progress` — a fact about the state
alone.**

- The diagram's own condition for abandoning is *window closed, no responses*. An attempt that was never
  started satisfies it exactly. The condition was right and the arrow was in the wrong place.
- The server's `abandon` carries the guard the diagram states: the attempt's window must have closed
  (`now` is a parameter, the domain reads no clock), and an in-progress attempt must hold no response. A
  `created` attempt holds none by construction.
- An attempt is **active** while it is `created` or `in_progress`. `submitted` and `abandoned` are
  terminal. Nothing in the definition reads the time.

### Why not "a created attempt past its window is not active"

It makes activity a function of the clock. Then "one active mock per student" can no longer be a property
of stored state: a database cannot say *created and past its window* in a unique index, because `now()` is
not immutable and an index predicate must be. The rule would live in application code that reads, then
decides, then writes, and two concurrent attempts would both pass it. With activity defined by state alone,
the rule is a partial unique index on `(student_id)` for mock attempts in the two live states, and the
database refuses the second attempt whoever races whom.

### What the edge does not do

A created attempt blocks a second mock **until its window closes and something abandons it** — within the
window that is the intended behaviour, since resuming the first is what the student should do. The domain
can now end such an attempt; nothing yet *does* it on the window closing. That is recorded as D54, with the
scheduling track as its trigger.

## Consequences

- ASSESSMENT-ENGINE §5 carries a dated correction note rather than a rewrite.
- Both copies of the machine change together: the client engine's table (`packages/attempt-engine`) and the
  server's (`contexts/assessment/domain/attempt-state.ts`). The engine is not imported by `apps/api`, so the
  two are separate implementations of one rule; each enumerates its full matrix, and the server's is checked
  against the database trigger that enforces the same edges.
- A test fails if the other reading returns: `isActive` takes no time argument and a created attempt past
  its window is active until abandoned.
