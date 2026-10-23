# ADR-0038 — The outbox relay delivers at least once, a scheduler drives it and the sweeps, and scoring is its first consumer

**Status** Accepted · M6 Track F, M6-38 to M6-43 · Closes D17 and D60; restates D35, D36 and D40

## Context

Every context wrote `platform.outbox_message` transactionally and nothing read it (D17). Submitting an attempt moved its state and
emitted nothing, so "scores once" was true only because nothing was scored (D60). The sweeps that open and close windows, abandon
attempts and escalate reviews had no caller, recorded as waiting for a deployed scheduler (D36). Accepting a candidate spans two
contexts and two transactions (D40).

## Decision

**The relay guarantees at-least-once delivery, in order per aggregate among live messages, and leaves the effect happening at most once to
the consumer.** A message leaves the live backlog only when every consumer for its type has returned. It is claimed under a lease (one
statement, `FOR UPDATE SKIP LOCKED`, so concurrent relays share the work), a consumer that throws leaves it claimable after a doubling back-off,
and a relay that dies mid-delivery leaves it claimable when the lease runs out. Exactly-once delivery is not claimed: a consumer's effect and
the relay's acknowledgement cannot be one transaction in general, so a consumer must be idempotent on the message. Only the earliest live
message of an aggregate is claimable, so a later one waits; across aggregates there is no order. Ordering is by occurrence time, the producing
transaction's clock reading, not its commit order.

**A poison message does not stall the queue.** After the policy's attempts it is dead-lettered — kept, with its last error and without its
payload — and stops blocking its aggregate. An operator reads the dead letters and `requeue`s one once the cause is fixed. Dead-lettering
means a consumer can see an aggregate's later message without its earlier one.

**The payload discipline is a gate on what the relay emits.** A payload is refused — dead-lettered before any consumer sees it — if it names a
key-bearing field, a field where a stem, a solution or a justification lives, or carries prose (a long or multi-line string) under any name.
The gate is by name and by shape because each catches what the other misses. A scan over every envelope the relay hands over for real
messages finds nothing; the same scan finds the material in the content tables the events describe, and in a planted message the relay then
refuses.

**Submission writes its event in the same transaction as the state change**, and only if the move happened: the winner of a race writes the
message, the loser writes nothing, and an event the store refuses rolls the submission back. A retry writes nothing.

**Scoring consumes `AttemptSubmitted`.** Its barrel is the only way in and `AnswerKeyData` the only thing that crosses: content's seam gives the
keys of the pinned versions to the system alone; curriculum's gives the marking rules and aggregation for the pinned profile; scoring's own
constructor builds the input and scoring's handler marks it. One record exists per submission under retry, redelivery and concurrent delivery,
because scoring's handler returns the current record and its store refuses a second; a delivery that loses the race asks again and is handed
the winner's. A submission whose scoring fails is retried, dead-lettered where an operator can see it, and requeued; meanwhile its result reads
`pending`, never an error and never absent.

**A scheduler drives the relay and the sweeps, in-process** — and D36 no longer waits on a deployment for the *trigger*. `tick(now)` runs
whatever is due as of a supplied moment; nothing in it reads a clock or sleeps. Each instance runs its own copy, safe because the jobs claim or
are idempotent; there is no leader. The process starts it on real timers (`main.ts`, unless `BACKGROUND_JOBS_ENABLED` is false); the
application itself starts none. An attempt whose deadline passed with no device to say so is submitted as an `expiry`, by key `expiry:<attempt>`,
writing its event as a student's own submission would. Two rules keep it so: a timer is started only in the port, and the relay and scheduler read
no clock.

**D40 is not closed.** The relay supplies the mechanism that would close it: record the decision and an event in generation's transaction, and let
a consumer create the content draft. Doing so needs the consumer to be idempotent on the candidate, and content's `CreateItemDraft` has no
idempotency key — a redelivery would create a second draft, which is the defect again. It also changes accept from a call that returns the
draft's id to one that does not. Both are work this track did not do; the entry says so.

## Consequences

- Messages of types no consumer is registered for are left untouched, so a consumer that arrives later drains its history. Only
  `AttemptSubmitted` has one.
- The application role holds `UPDATE` on the outbox's delivery columns only, by column grant; a trigger refuses a change to anything the
  producing transaction wrote, even to a role that has the privilege.
- The scoring route (`/v1/attempts/{id}/score-records/current`) cannot be satisfied by a learner: its ownership check needs an owner the route
  does not know (D63). The student's result is read through assessment, which does.
