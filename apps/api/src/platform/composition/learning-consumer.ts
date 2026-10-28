import type { PrincipalRef } from '@questionbank/domain-types';
import type { ReportSlotSource } from '../../contexts/learning/public/composition.js';
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
 * standing for, and a payload that is not an `AttemptScored` or `AttemptScoreSuperseded` will not be mended by trying again, so they are `PermanentDeliveryFailure` and are dead-lettered
 * on the delivery that found them, where an operator can see them. The distinction matters because the alternative to a dead letter here is a mastery update
 * that silently never happens.
 *
 * **A correction is the same delivery with a different cause (D72, ADR-0053).** A re-score writes one `AttemptScoreSuperseded` per attempt it superseded, in the
 * transaction that supersedes it, and this consumer handles it exactly as it handles `AttemptScored`: it assembles the attempt's evidence from the score that stands
 * now and hands the whole set to the recorder, which stores what is new, corrects what a stored response is now worth, withdraws what no longer counts, and
 * re-decides the transitions of every concept it corrected. Both messages name the attempt and a score record, and the evidence is read from the owning
 * contexts at delivery either way (a burst of them queues ahead of a live submission: D82), so a message that waited behind a second re-score reconciles to the latest one, and a replay is a no-op.
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
      { learnerRef: assembled.value.learnerRef, evidence: assembled.value.evidence, gaveUp: assembled.value.gaveUp, attemptRef: attemptId },
      { principal: SYSTEM, correlationId: envelope.correlationId },
    );
    if (recorded.ok) return;
    if (recorded.error.kind === 'Unavailable') throw new Error(`${recorded.error.code}: ${recorded.error.message}`);
    throw new PermanentDeliveryFailure(`${recorded.error.code}: ${recorded.error.message}`);
  }
}


/**
 * Learning's diagnostic report for a scored mock (M7-42, DEC-M7-21). It listens to the same two events as the evidence consumer and runs after it, so a report
 * is never made from a score whose evidence Learning has not yet recorded. The same score record twice is one report (`created: false` the second time), and a
 * superseded score is a new score record, so a re-score gives the learner a new report beside the one they were shown.
 */
export class LearningDiagnosticReportConsumer implements OutboxConsumer {
  readonly name = 'learning.diagnostic-report';

  constructor(private readonly deps: { readonly slots: ReportSlotSource; readonly learning: LearningForRelay }) {}

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const { attemptId, scoreRecordId } = envelope.payload;
    if (typeof attemptId !== 'string' || attemptId === '' || typeof scoreRecordId !== 'string' || scoreRecordId === '') {
      throw new PermanentDeliveryFailure('an AttemptScored or AttemptScoreSuperseded message names no attempt or no score record');
    }
    const assembled = await this.deps.slots.slotsForScoredAttempt({ attemptId, scoreRecordId, scoredAt: envelope.occurredAt });
    if (!assembled.ok) {
      const { error } = assembled;
      if (error.code === 'SOURCE_UNAVAILABLE') throw new Error(`${error.code}: ${error.message}`);
      throw new PermanentDeliveryFailure(`${error.code}: ${error.message}`);
    }
    const generated = await this.deps.learning.generateReport.handle(
      { learnerRef: assembled.value.learnerRef, attemptRef: attemptId, scoreRecordRef: scoreRecordId, slots: assembled.value.slots },
      { principal: SYSTEM, correlationId: envelope.correlationId },
    );
    if (generated.ok) return;
    if (generated.error.kind === 'Unavailable') throw new Error(`${generated.error.code}: ${generated.error.message}`);
    throw new PermanentDeliveryFailure(`${generated.error.code}: ${generated.error.message}`);
  }
}
