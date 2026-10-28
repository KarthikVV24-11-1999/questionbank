# ADR-0053 — A re-score announces each attempt it superseded, and Learning corrects beside the record

**Status** Accepted · M7 Track F, M7-40 · Closes D72; extends [ADR-0042](ADR-0042-a-score-and-its-event-are-written-in-one-transaction.md) from a first score to a correction

## Context

`ExecuteRescoring` superseded score records one transaction at a time, then wrote `AttemptsRescored` carrying an operation, a count, a trigger and a scope. It named no attempt and wrote no
`AttemptScored` for a successor, so Learning, which holds evidence assembled from generation 1, never heard that an outcome was corrected. That was internal staleness until the diagnostic
report: the first artefact a learner reads about their own exam would go on naming a concept they did not lose marks to, ranked by a number that was no longer true.

The same method also had ADR-0042's defect one layer up. The supersessions committed one by one, and the completion and its event in a transaction of their own; a crash between them left
attempts whose score was replaced and consumers who were never told, in an operation that was still `executing`.

## Decision

**The announcement is one event per superseded attempt.** `AttemptScoreSuperseded` carries the operation, the attempt, the score record that now stands, the one it replaced and the generation.
`AttemptsRescored` stays, as the operation's own fact. A single event listing every attempt was rejected on the consumer's terms: Learning's work is per attempt, so a delivery that fails
should fail for one attempt and not retry or dead-letter thousands beside it, and an event whose payload grows with the scope of a rule correction has no bound. `AttemptScored` for each
successor was rejected because a consumer would have to open the payload to learn that a "first score" is a correction; a fact of its own is named for what happened (DEC-M7-19).

**The supersessions, the completion and every announcement are one transaction.** `RescoringOperationRepository.completeWithSuccessors` stands every predecessor down, writes every successor,
moves the operation to `completed` and writes every event on one connection, behind the operation's version guard. Proved by refusing the outbox write: the operation stays `executing`, no
second generation exists, and the first score is still the current one. The test is red against the previous shape, which committed each supersession before the event write.

**Learning corrects beside the record, never in it.** Evidence is history, so a response a re-score changes gets a row in `learning.evidence_correction`, and what it counts as now is the
latest row. A response the score no longer counts is corrected to `withdrawn`. The consumer handles the new message exactly as it handles `AttemptScored`: it assembles the attempt's evidence
from the score that stands, and the recorder compares it with what is stored, so a message that waited behind a second re-score reconciles to the latest one, and the same message twice writes
nothing.

**A promotion granted on a corrected outcome does not survive** (DEC-M7-20). For each concept with a corrected response the history is re-advanced from nothing over the evidence as it now
stands and held against the stored transitions: the leading transitions that agree are kept, with the rules that decided them, and everything from the first disagreement on is revoked in
`learning.transition_revocation` and replaced by what the corrected evidence gives. Nothing is deleted; a reader that asks where a concept stands does not see a revoked transition. A concept
left with no evidence has no state, because unassessed is the absence of one.

## Consequences

**Makes easy:** a consumer can rely on "a score was replaced if and only if its attempt was announced"; the report can be built on Learning's state without a second source of truth.

**The transaction is the size of the operation.** Every successor, its sections, its outcomes and its events are written in one transaction, so a rule correction over thousands of attempts holds
its locks for as long as the writes take. That is the price of there being no half-applied correction; an operator who wants smaller units scopes the operation smaller. The transaction was measured
with three attempts, not thousands.

**Not closed here:** a re-score does not yet correct a learner's *error notebook* (D81), and a burst of announcements queues ahead of a live submission in the relay's occurrence order (D82).

**Departure:** a replayed tail is decided under the rule set in force when it is replayed; the revoked transitions keep the pins they were made under. `MasteryTransition`'s header says history is
advanced and not replayed under today's thresholds, and for the unaffected prefix that still holds; for the part a correction touches, the decision is being made again and is made under today's rules.
