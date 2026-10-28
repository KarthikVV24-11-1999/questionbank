import type { PrincipalRef } from '@questionbank/domain-types';
import type { LearningForRelay } from '../../contexts/learning/public/composition.js';
import type { MasteryEvidenceSource } from '../../contexts/learning/public/composition.js';
import { ROLES } from '../auth/roles.js';
import { PermanentDeliveryFailure, type OutboxConsumer, type OutboxEnvelope } from '../outbox/relay.js';

/**
 * Learning's consumer of `AttemptScored` (M7-16, ADR-0038).
 *
 * **At-least-once delivery, at-most-once effect.** The relay may hand the same message over more than once. The effect is Learning's ledger recording each
 * response once per attempt and slot, and doing nothing else for a response it already holds — no sitting placed, no state recomputed, no transition appended —
 * so the same event twice is one set of evidence and one recomputation.
 *
 * **Retry and dead letter are told apart by cause.** A store that is down, or a read that did not complete, may pass: that is an ordinary failure and the relay
 * retries it with a back-off. An item version content cannot resolve, a score that does not exist, a response scoring counted that the log has no response
 * standing for, and a payload that is not an `AttemptScored` will not be mended by trying again, so they are `PermanentDeliveryFailure` and are dead-lettered
 * on the delivery that found them, where an operator can see them. The distinction matters because the alternative to a dead letter here is a mastery update
 * that silently never happens.
 *
 * **D72 stays open.** A re-score writes `AttemptsRescored`, which names an operation and a count and not the attempts it changed, and writes no `AttemptScored`
 * for the successors. This consumer therefore never hears that an outcome was corrected, and does not guess.
 */
const SYSTEM: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-8000-0000000000f8', roleContext: [ROLES.system] };

export interface LearningConsumerDeps {
  readonly evidence: MasteryEvidenceSource;
  readonly learning: LearningForRelay;
}

export class LearningAttemptScoredConsumer implements OutboxConsumer {
  readonly name = 'learning.attempt-scored';

  constructor(private readonly deps: LearningConsumerDeps) {}

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const { attemptId, scoreRecordId } = envelope.payload;
    if (typeof attemptId !== 'string' || attemptId === '' || typeof scoreRecordId !== 'string' || scoreRecordId === '') {
      throw new PermanentDeliveryFailure('an AttemptScored message names no attempt or no score record');
    }

    const assembled = await this.deps.evidence.evidenceForScoredAttempt({ attemptId, scoreRecordId, scoredAt: envelope.occurredAt });
    if (!assembled.ok) {
      const { error } = assembled;
      if (error.code === 'SOURCE_UNAVAILABLE') throw new Error(`${error.code}: ${error.message}`);
      throw new PermanentDeliveryFailure(`${error.code}: ${error.message}`);
    }

    const recorded = await this.deps.learning.recordEvidence.handle(
      { learnerRef: assembled.value.learnerRef, evidence: assembled.value.evidence, gaveUp: assembled.value.gaveUp },
      { principal: SYSTEM, correlationId: envelope.correlationId },
    );
    if (recorded.ok) return;
    if (recorded.error.kind === 'Unavailable') throw new Error(`${recorded.error.code}: ${recorded.error.message}`);
    throw new PermanentDeliveryFailure(`${recorded.error.code}: ${recorded.error.message}`);
  }
}
