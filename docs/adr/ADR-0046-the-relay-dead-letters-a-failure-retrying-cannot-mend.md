# ADR-0046 — The relay dead-letters a failure retrying cannot mend

**Status** Accepted · M7 Track B, M7-16 · Amends [ADR-0038](ADR-0038-the-outbox-relay-delivers-at-least-once-and-scoring-is-its-first-consumer.md)

## Context

ADR-0038's relay treats every consumer failure alike: back off, retry, and dead-letter after the policy's attempts. That is right for a store that is down and
wasteful for a message that can never be acted on — an item version content cannot resolve, a score that does not exist — because it spends the attempts on a
certain outcome and, per aggregate, holds every later message behind it while it does. Learning is the first consumer for which the two causes differ, and for
which the alternative to a dead letter is a mastery update that silently never happens.

## Decision

A consumer throws `PermanentDeliveryFailure` when retrying cannot help, and the relay dead-letters the message on the delivery that threw it, with the failure as
its reason. Any other error is retried as before. Learning's consumer throws it for an unresolved item version, an attempt with no score, a response scoring
counted that the log has no response standing for, a payload that is not an `AttemptScored` and a recorder refusal that is not the ledger being unavailable; it
retries `SOURCE_UNAVAILABLE` and `LEDGER_UNAVAILABLE`.

A dead-lettered message stops blocking its aggregate, as ADR-0038 already says of any dead letter, and an operator can `requeue` it once the cause is fixed.

## Consequences

**Makes easy:** the dead-letter queue shows what needs a person, promptly, and the retry budget goes on what might pass.

**Makes hard:** a consumer that throws `PermanentDeliveryFailure` for something that would have passed loses the retry; the cause lists above are the ones that
were reasoned to be certain, and a new one is a reviewed addition.

**Does not change** the guarantees: at least once, in order per aggregate among live messages, and the effect at most once being the consumer's job.
