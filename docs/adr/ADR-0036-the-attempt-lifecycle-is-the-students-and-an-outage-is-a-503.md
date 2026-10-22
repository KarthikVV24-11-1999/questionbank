# ADR-0036 — The attempt lifecycle is the student's, a late event is kept, and an unreachable store is a 503

**Status** Accepted · M6 Track E, M6-30 to M6-35 · Clarifies ASSESSMENT-ENGINE §4 and §5

## Context

Track E puts the attempt's lifecycle on routes: create, start, read, send events, submit. Four things the approved
documents leave open, or leave in tension, had to be decided.

## Decision

**1. Who calls what.** Every attempt route names `learner` and no one else, and then checks the attempt is the caller's
own: someone else's is `404`, the same answer as one that does not exist. The routes live under `/v1/assessment/attempts/`
(ADR-0033), not at the paths BACKEND-ARCHITECTURE §3 sketches.

**2. The server's, and only the server's.** The deadline, the duration, the window and every pin are copied from the form
and from the exam profile version curriculum holds; nothing a client sends can set one. A body that sends one has it
ignored — dropped, not refused — and a spec sends them to show it. Curriculum gives assessment the pins through a
seam-only read (`GetExamProfilePins`) that has no route, so its contracted public view is unchanged.

**3. A late event is recorded and excluded, not refused.** The Track E document asks that an event for a submitted
attempt be "refused, not silently dropped", and that the log be "closed to further events at submission". ASSESSMENT-ENGINE
§4 says events arriving after submission are **recorded but excluded from scoring**, and the engine, the schema trigger
and the domain already implement that. Refusing them would lose a response a device captured before the learner submitted
and could not send until after — exactly the case a backend outage produces. The two are reconciled this way: a late event
is answered `late` (never silently accepted, never dropped, never counted) and kept with `after_submission` set by the
database whatever the writer says; an event for an attempt that is not in progress or submitted (`created`, `abandoned`) is
refused as a whole. "Closed" is read as "closed to *counting* events".

**4. A reason is never relabelled.** An `expiry` submission is refused before the server's deadline. A `manual` submission
after it is recorded as `manual` with `pastDeadline` set — visible, not turned into an expiry, and not lost. A retry under
the same key returns the submission that exists.

**5. An unreachable store is `503`, retryable.** A connection that cannot be made, or that drops, was reported as a rejected
write — a `400` — which a device would read as a verdict on its events. It is now `Unavailable`, `503`, retryable, and the
device holds its queue and tries again. This was found by the outage scenario (M6-35), not by reading.

**6. Creating an attempt is idempotent on a key the student chose** (`Idempotency-Key`), stored with the attempt and unique
per student; a second active mock is a `409` that names the first, and the unique index is what decides it when two
requests race past the friendly check.

## Consequences

- Submission triggers nothing yet: no scoring is requested (D60).
- The batch is capped at 200 events; the platform's default body limit made 500 unreachable in practice.
- A manual submission late by an hour is accepted. That is a choice, not a proof that it is right: the alternative
  (refuse, and let the device's expiry submission follow) is open if the exam rules want it.
