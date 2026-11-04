import { createAnswerKey, createScoringInput, type ScoreAttempt } from '../../../scoring/public/index.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import type { AttemptRepository, ResponseLog } from '../../domain/repository-ports.js';
import { projectLog } from '../../domain/response-log.js';
import type { ApplicationContext } from '../ports.js';
import { SCORING_CONSUMER_PRINCIPAL_ID, ScoringFailure, toResponseSnapshot, type Scorer, type ScoringKeyReader, type ScoringSpecReader, type SubmittedEnvelope } from './scoring-consumer.js';

/**
 * Scores a submitted practice run (M8-25, closes D77; ADR-0061, DEC-M8-14 in docs/IMPLEMENTATION-DECISIONS.md): the consumer of `PracticeAttemptSubmitted`, beside the consumer of `AttemptSubmitted` and not inside it.
 *
 * **What scoring read the form for, and what a run supplies instead.** The mock consumer reads the form for one thing: the slots to mark, in sections, each with the marks it is worth. A run
 * has its own slots (the attempt holds them, with the item version each pinned), so *which slots* needs no form. *What a slot is worth* does: a form's slot carries `marksPerItem` from its
 * blueprint, a run's has none. Nothing is invented for it. Marking is the rule set the run pinned (`markingRuleSetHash`, checked against the profile exactly as for a mock), and a slot is worth
 * what the profile's sections pay per item when they all pay the same (`marksPerItem` from curriculum); where they differ there is no single answer for an item that belongs to no section, and the
 * delivery fails loudly with `PRACTICE_MARKS_UNDEFINED` and goes to the dead letters, not to a zero (D110 in docs/DEBT.md).
 *
 * **What a run cannot give, and is not given.** A run has no sections: the score input has one section, ordinal 1, holding every slot, and it stands for nothing in the profile. The profile's `bestOf`
 * names sections of the paper and would drop answers from a section that is only a bag of slots, so it is not passed on; rounding and the floor are. A run has no total marks and no pass mark: the
 * score record's total is the sum of what the slots are worth, and nothing here reads a number the run never had.
 *
 * Everything else is the mock consumer's, and is held the same way: the answers read are the projection of the log with the attempt's own pinned cap, an unreadable answer is unattempted, the
 * idempotency key is the submission's, a lost race asks again, and any failure throws, so the relay retries and then dead-letters it where an operator can see it. A run on a form arriving here, or a
 * mock arriving at the other consumer, is a fault to see and not a delivery to skip.
 */
/**
 * Where the fact that a run was completed is said (M8-34, D112): a port this context declares and the root fills with the analytics emitter, because a context reaches `platform/` for the role vocabulary and
 * nothing else. The event's id is derived from `factKey`, so a delivery that comes twice, or a re-score, says it once.
 */
export interface RunEvents {
  emit(event: {
    readonly name: 'practice.session_completed';
    readonly factKey: string;
    readonly occurredAt: string;
    readonly actor: string;
    readonly context: { readonly attempt_id: string };
    readonly payload: { readonly items_attempted: number; readonly accuracy: number; readonly duration_ms: number };
  }): Promise<void>;
}

export interface PracticeScoringConsumerDependencies {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
  readonly responses: Pick<ResponseLog, 'findByAttempt'>;
  readonly keys: ScoringKeyReader;
  readonly spec: ScoringSpecReader;
  readonly scorer: Scorer;
  /** Absent where nothing listens; then a run is scored and nothing is said of it. */
  readonly events?: RunEvents;
}

export class ScorePracticeAttemptConsumer {
  readonly name = 'ScorePracticeAttempt';

  constructor(private readonly deps: PracticeScoringConsumerDependencies) {}

  async handle(envelope: SubmittedEnvelope): Promise<void> {
    const attemptId = envelope.payload['attemptId'];
    if (typeof attemptId !== 'string') throw new ScoringFailure('PAYLOAD_INVALID', 'the event names no attempt');
    const context: ApplicationContext = {
      principal: { kind: 'system', id: SCORING_CONSUMER_PRINCIPAL_ID, roleContext: [ROLES.system] },
      correlationId: envelope.correlationId,
    };

    const attempt = await this.deps.attempts.findById(attemptId);
    if (!attempt.ok) throw new ScoringFailure(attempt.error.code, attempt.error.message);
    if (attempt.value.state !== 'submitted') throw new ScoringFailure('ATTEMPT_NOT_SUBMITTED', `attempt ${attemptId} is ${attempt.value.state}`);
    if (attempt.value.mode !== 'practice' || attempt.value.formId !== null) throw new ScoringFailure('ATTEMPT_IS_NOT_A_PRACTICE_RUN', `attempt ${attemptId} was sat on a form and is scored against it`);
    if (attempt.value.slots.length === 0) throw new ScoringFailure('PRACTICE_RUN_HAS_NO_SLOTS', `practice run ${attemptId} holds no slot to mark`);
    const events = await this.deps.responses.findByAttempt(attemptId);
    if (!events.ok) throw new ScoringFailure(events.error.code, events.error.message);

    const itemVersionIds = [...new Set(attempt.value.slots.map((slot) => slot.itemVersionId))];
    const keys = await this.deps.keys.handle({ itemVersionIds }, context);
    if (!keys.ok) throw new ScoringFailure(keys.error.code, keys.error.message);
    const spec = await this.deps.spec.handle({ profileVersionId: attempt.value.examProfileVersionId }, context);
    if (!spec.ok) throw new ScoringFailure(spec.error.code, spec.error.message);
    if (spec.value.markingRuleSetHash !== attempt.value.markingRuleSetHash) {
      throw new ScoringFailure('MARKING_RULES_NO_LONGER_MATCH_THE_PIN', 'the exam profile no longer hashes to the rules this run pinned');
    }
    const marksPerItem = spec.value.marksPerItem ?? null;
    if (marksPerItem === null) throw new ScoringFailure('PRACTICE_MARKS_UNDEFINED', 'the exam profile\'s sections do not pay the same for each item, so a slot that belongs to no section is worth no one number');

    const answers = new Map(projectLog(attempt.value, events.value).slots.map((slot) => [slot.slot, slot.answer]));
    const keyOf = new Map(keys.value.map((view) => [view.itemVersionId, view]));
    const slots = [];
    for (const [index, slot] of [...attempt.value.slots].sort((a, b) => a.ordinal - b.ordinal).entries()) {
      const key = keyOf.get(slot.itemVersionId);
      if (key === undefined) throw new ScoringFailure('ANSWER_KEY_MISSING', `no key for item version ${slot.itemVersionId}`);
      const answerKey = createAnswerKey(key.answerKey);
      if (!answerKey.ok) throw new ScoringFailure(answerKey.error.code, answerKey.error.message);
      const response = toResponseSnapshot(key.itemType, answers.get(slot.slotId));
      slots.push({
        slotId: slot.slotId,
        ordinal: index + 1,
        itemType: key.itemType,
        itemVersionId: slot.itemVersionId,
        marksAvailable: marksPerItem,
        answerKey: answerKey.value,
        ...(response === undefined ? {} : { response }),
      });
    }

    const input = createScoringInput({
      attemptId,
      pin: {
        examProfileVersionId: attempt.value.examProfileVersionId,
        markingRuleSetHash: attempt.value.markingRuleSetHash,
        ruleSchemaVersion: spec.value.markingRuleSet.schemaVersion,
        taxonomyVersionId: attempt.value.taxonomyVersionId,
        itemVersionIds,
      },
      sections: [{ ordinal: 1, slots }],
      overrides: [],
    });
    if (!input.ok) throw new ScoringFailure(input.error.code, input.error.message);

    const { bestOf: _sectionsOfAPaper, ...aggregation } = spec.value.aggregation as ScoreAttempt['aggregation'] & { bestOf?: unknown };
    const command: ScoreAttempt = {
      input: input.value,
      ruleSet: spec.value.markingRuleSet,
      ruleSetHash: attempt.value.markingRuleSetHash,
      aggregation: aggregation as ScoreAttempt['aggregation'],
      idempotencyKey: `submission:${attemptId}`,
    };
    const scored = await this.deps.scorer.handle(command, context);
    if (scored.ok) return this.announce(attemptId, attempt.value, scored.value);
    if (scored.error.code === 'CONFLICT') {
      const again = await this.deps.scorer.handle(command, context);
      if (again.ok) return this.announce(attemptId, attempt.value, again.value);
      throw new ScoringFailure(again.error.code, again.error.message);
    }
    throw new ScoringFailure(scored.error.code, scored.error.message);
  }

  /**
   * `practice.session_completed` (D112, DEC-M8-21 in docs/IMPLEMENTATION-DECISIONS.md): said once the run is scored, because accuracy is a fact scoring has and the device does not. The run is *attempted* by the answers that were given and came out right or wrong;
   * accuracy is the share of those that were right. A run with none given has no accuracy to state and says nothing, and so does one with no start or no submission to measure the time between. `duration_ms` is the
   * wall time from the run's start to its submission, a run being put down and picked up in between: it is not time spent answering, and the catalog's field is named for the span.
   */
  private async announce(attemptId: string, attempt: { readonly studentId: string; readonly startedAt: string | null; readonly submission: { readonly submittedAt: string } | null }, record: unknown): Promise<void> {
    const outcomes = (record as { readonly itemOutcomes?: readonly { readonly correctness: string }[] }).itemOutcomes ?? [];
    const attempted = outcomes.filter((outcome) => outcome.correctness === 'correct' || outcome.correctness === 'incorrect');
    if (this.deps.events === undefined || attempted.length === 0 || attempt.startedAt === null || attempt.submission === null) return;
    const correct = attempted.filter((outcome) => outcome.correctness === 'correct').length;
    await this.deps.events.emit({
      name: 'practice.session_completed',
      factKey: attemptId,
      occurredAt: attempt.submission.submittedAt,
      actor: attempt.studentId,
      context: { attempt_id: attemptId },
      payload: { items_attempted: attempted.length, accuracy: Math.round((correct / attempted.length) * 10_000) / 10_000, duration_ms: Math.max(0, Date.parse(attempt.submission.submittedAt) - Date.parse(attempt.startedAt)) },
    });
  }
}
