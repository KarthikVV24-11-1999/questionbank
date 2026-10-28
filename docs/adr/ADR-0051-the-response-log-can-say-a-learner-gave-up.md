# ADR-0051 — The response log can say a learner gave up, and a give-up is not evidence

**Status** Accepted · M7 Track E, M7-35 · Extends ASSESSMENT-ENGINE §4 and DOMAIN-MODEL `ResponseEvent`

## Context

FRS 277: in practice, solutions unlock "only after an attempt or an explicit skip — never before". The response log had a kind for attempting (`select`, `change`) and none for
giving up, so half the trigger could not be expressed. A gate built on what was there would have released on `visit`, which is scrolling past, not effort: an answer key behind
one scroll.

## Decision

**A `skip` event kind**, in the database check, in `packages/attempt-engine` (the kind list, the event type, the projection), in the server's event vocabulary and mapping, in
the OpenAPI document, and in the learner client, which emits it. Append-only like every event, idempotent on the event id, carried by REL-06's set union unchanged.

**The projection** gains `skipped` per slot: set by a `skip`, withdrawn by a later `select` or `change` (the learner then attempted the question). A skip never discards a recorded
answer — only a `clear` does — so `skipped` can be true beside an answer, and the answer is what scoring reads.

**The merge case.** A skip on one device and an answer on another resolve by the canonical order (client sequence, then event id), the same in either arrival order; a skip later
than the answer stands beside it, a skip earlier than the answer is withdrawn by it. Tested in both orders, with a planted arrival-order merge shown to differ.

**What a skip means to scoring: nothing.** A skip is not evidence. A learner who gives up has told us they do not know, not what they got wrong, and D-002 counts responses; counting
a skip as an incorrect response would let the act of giving up move mastery in the same direction as a mistake, and would make a mock-day skip of forty questions forty pieces of
evidence about concepts the learner never engaged. It therefore needs no scoring change at all: the projection's answer is `null`, scoring reads `unattempted`, Learning ignores it.
The alternative — *attempted and wrong* — gives different mastery for the same log, which is why it is decided here and not left to the projection.

## Consequences

**Makes easy:** the effort gate has both triggers in the log, and the error notebook can tell a question given up on from one never touched (ADR-0052, DEC-M7-16).

**Makes hard / not claimed:** a skip is free, so the gate is a floor on effort and not a measure of it. The learner client emits a skip through its session; the button is the learner
surfaces' (Track H).
