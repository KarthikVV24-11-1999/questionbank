# ADR-0042 — A score and its event are written in one transaction

**Status** Accepted · M7 Track A, M7-01 · Closes the limitation in `scoring/public/composition.ts` that had no register entry; restates D35

## Context

`PostgresEventPublisher` opened its own transaction for each event, so a score record committed in one transaction and its `AttemptScored`
row in `platform.outbox_message` in another. The file's header said so. Through M6 nothing consumed `AttemptScored` and the gap cost nothing.
Learning's only input is that event, and a crash between the two commits would leave a score that exists and an event that never will:
a mastery update that never happens, with no message in the outbox to fail and so nothing the dead-letter queue could show.

D35 named assessment to scoring as the atomic example since M6-39. Scoring to anything downstream was never given the same treatment.

## Decision

The repository takes the event with the record and writes both on one connection. `ScoreRecordRepository.save(record, event?)` emits
through `ScoringOutboxEmitter` on the client the record was written on; `RescoringOperationRepository.save(operation, event?)` does the
same for `AttemptsRescored`, so an operation is never `completed` without its event. `ScoreAttemptHandler` builds the event from the record
and hands both over; it no longer publishes afterwards. `PostgresEventPublisher` and the two `EventPublisher` ports are deleted rather than
wrapped, because the shape was wrong and not the implementation.

Proven by failing the outbox insert on the connection the record was written on: no `score_record`, `item_outcome` or event row survives,
and the same attempt then scores once with exactly one event. The test is red against the previous shape (commit, then write the event).

A reconciling sweep was rejected. It would have Learning read scoring's tables to find scores it never heard about, which the boundary rules
forbid and the seams in ADR-0043 do not grant.

## Consequences

**Makes easy:** a consumer can rely on "a score exists if and only if its event does".

**Does not change** D35: the cross-context *reaction* is still eventual. What is closed is the window in which the fact existed and its
announcement did not.

**Found and not fixed here (D72):** `ExecuteRescoring` writes `AttemptsRescored` carrying an operation and a count, not the attempts
whose outcomes changed, and `ScoreAttempt` writes `AttemptScored` only for a first score. Learning cannot learn that a re-score corrected an outcome.
