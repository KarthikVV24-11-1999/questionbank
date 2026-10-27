# ADR-0045 — Evidence is dated by the response, and assessment offers the instant

**Status** Accepted · M7 Track B, M7-11 · Extends [ADR-0043](ADR-0043-learning-reads-the-owning-contexts-through-two-seams.md) from two seams to three; carries DEC-M7-2

## Context

Track A set a piece of evidence's `occurredAt` to the instant its attempt was *scored* and said so as a departure. Every slot of an attempt is scored at once, so
all seventy-five responses carried one instant, and two of D-002's four clauses are measured on it. A `StudySession` closed by an idle gap cannot see a gap that is
always zero: one attempt would be exactly one session, which happens to be right for a mock and silently wrong for a pausable run resumed three days later. A
verification "forty-eight hours later" would be measured from the score and not from the response. The rule would have computed, from data in which only one value
was possible, and no test would have noticed.

## Decision

Assessment offers a third seam, `assessmentForLearning`: for a submitted attempt, per slot, the server's instant for the response that **stands** (the last of the
events that set an answer, among those that reached the server before submission) and the slot's time on item, with the learner the attempt belongs to. No answer,
no event payload, no kind. The system's alone, no route. A late event is recorded and excluded from scoring (§4); it is not evidence either.

`MasteryEvidence.occurredAt` is that instant. The scoring instant is kept apart as `scoredAt`, and a response cannot follow the score that counted it. An attempt
with a response scoring counted and the log has no response standing for is a disagreement between two contexts and fails whole.

Which event stands is stated once, in `response-timing.ts`, beside the engine's projection that states it by folding every event, and a spec holds the two to each
other over generated logs. The learner is named in the answer because nothing else between a submission and a mastery update carries one.

## Consequences

**Makes easy:** sittings and verification are measured on what the learner did, for a mock and for a practice run alike.

**Makes hard:** Learning's evidence is only as good as the response log's instants, which are the server's and not the device's.

**Does not change** the key-free boundary: identifiers, instants and durations cross, as for the other two seams.
