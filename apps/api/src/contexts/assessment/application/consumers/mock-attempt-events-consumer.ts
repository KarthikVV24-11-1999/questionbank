import { projectLog } from '../../domain/response-log.js';
import type { AttemptRepository, ResponseLog } from '../../domain/repository-ports.js';
import type { MockEvents } from '../mock-events.js';
import { ScoringFailure, type SubmittedEnvelope } from './scoring-consumer.js';

/**
 * Says `mock.attempt_submitted` for an attempt on a form (M8-54), from the outbox's `AttemptSubmitted`, beside the consumer that scores it. It is a consumer of its own and not a step in
 * scoring's, so a score that fails and goes to the dead letters does not keep the fact that the attempt was submitted out of the completion rate, and an event that cannot be said does not
 * fail a score. It throws only for a message that names no attempt, or an attempt that is not there or not submitted, which are faults to see and not deliveries to skip (as scoring's are).
 */
export interface MockAttemptEventsDependencies {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
  readonly responses: Pick<ResponseLog, 'findByAttempt'>;
  readonly events: MockEvents;
}

const MODE = { manual: 'manual', expiry: 'auto_expiry', recovered: 'recovered' } as const;

export class MockAttemptEventsConsumer {
  readonly name = 'SayMockAttemptSubmitted';

  constructor(private readonly deps: MockAttemptEventsDependencies) {}

  async handle(envelope: SubmittedEnvelope): Promise<void> {
    const attemptId = envelope.payload['attemptId'];
    if (typeof attemptId !== 'string') throw new ScoringFailure('PAYLOAD_INVALID', 'the event names no attempt');
    const attempt = await this.deps.attempts.findById(attemptId);
    if (!attempt.ok) throw new ScoringFailure(attempt.error.code, attempt.error.message);
    const { value } = attempt;
    if (value.submission === null) throw new ScoringFailure('ATTEMPT_NOT_SUBMITTED', `attempt ${attemptId} is ${value.state}`);
    if (value.formId === null) throw new ScoringFailure('ATTEMPT_IS_NOT_ON_A_FORM', `attempt ${attemptId} is a practice run, which has its own events`);
    const log = await this.deps.responses.findByAttempt(attemptId);
    if (!log.ok) throw new ScoringFailure(log.error.code, log.error.message);

    const projected = projectLog(value, log.value).slots;
    const answered = projected.filter((slot) => slot.answer !== null).length;
    const submittedAt = value.submission.submittedAt;
    const lastHeard = log.value.filter((event) => !event.afterSubmission).reduce<number>((latest, event) => Math.max(latest, Date.parse(event.serverReceivedAt)), Number.NEGATIVE_INFINITY);
    await this.deps.events.emit({
      name: 'mock.attempt_submitted',
      factKey: attemptId,
      occurredAt: submittedAt,
      actor: value.studentId,
      context: { attempt_id: attemptId },
      payload: {
        submission_mode: MODE[value.submission.reason as keyof typeof MODE],
        answered,
        unanswered: Math.max(0, value.slots.length - answered),
        flagged: projected.filter((slot) => slot.flagged).length,
        sync_lag_ms: Number.isFinite(lastHeard) ? Math.max(0, Date.parse(submittedAt) - lastHeard) : 0,
      },
    });
  }
}
