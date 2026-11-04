import { submitAttempt } from '../../domain/attempt.js';
import type { AttemptRepository } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { authorize, fromAssessment, type ApplicationError } from '../authorization.js';
import type { SubmitExpiredAttempts } from '../commands/form-commands.js';
import type { Handler } from '../handler-registry.js';
import { attemptSubmittedEvent } from './attempt-handlers.js';
import { SUBMIT_EXPIRED_ATTEMPTS_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock } from '../ports.js';

export interface ExpiryDependencies {
  readonly attempts: AttemptRepository;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

export interface ExpiryReport {
  readonly asOf: string;
  /** Attempts submitted by the sweep: mocks whose deadline passed and practice runs left alone, together. */
  readonly submitted: number;
  /** Of those, the practice runs: finished for a learner who did not come back. */
  readonly runsFinished: number;
  /** Moves that did not apply (another writer got there first, or the store refused), named so a retry knows what is left. */
  readonly skipped: readonly string[];
}

const DEFAULT_LIMIT = 200;

/**
 * How long a practice run may be left alone before the sweep finishes it for the learner (M8-36, D116, DEC-M8-22 in docs/IMPLEMENTATION-DECISIONS.md): forty-eight hours since the server last heard from the run. Not since it
 * began: a long run sat slowly is active throughout. Not a day: a learner who sits a run in the evening and finishes it the next evening is at twenty-four hours on a good day, and the sweep must not take the run from under them. Two days
 * is past any ordinary resumption and short enough that the answers reach the map in the same week; a learner who comes back after it finds the run finished, with what they had answered scored.
 */
export const PRACTICE_IDLE_MS = 48 * 3_600_000;

/**
 * Submits the attempts whose deadline has passed and whose device never came back to say so (M6-42, D36). A window closing does not do this for attempts already running in it: debt D64.
 *
 * **It also finishes a practice run left alone** (M8-36, D116). A run has no deadline, so nothing ever submitted it, and its answers were in the response log and in no one's map. A run whose last activity is older than
 * `PRACTICE_IDLE_MS` is submitted here, by the same path a learner's own submission takes: the one that writes a score record, evidence and the events, so there is no second way for a run to be finished. The reason is `expiry`
 * and the event is the practice one (`attemptSubmittedEvent` tells a run from a mock by its having no form), so the relay hands a run to the consumer for runs and a mock to the one for papers, in the same sweep.
 *
 * Track E distinguished an `expiry` submission from a late `manual` one; this is the caller that was missing — without it an
 * attempt whose device died stays `in_progress` for good, counting against its student's one active mock. The reason is
 * `expiry`, the key is derived from the attempt (`expiry:<id>`) so a second pass over the same attempt is a replay, and each
 * submission writes its `AttemptSubmitted` event in the same transaction as the state change, as a student's own would — so
 * scoring hears of it the same way.
 *
 * **A command, not a timer.** It takes its moment from the clock the application hands it, is idempotent (a second run finds
 * nothing left), and one attempt failing does not stop the rest. The scheduler calls it; there is no route.
 */
export class SubmitExpiredAttemptsHandler implements Handler<SubmitExpiredAttempts, ExpiryReport> {
  readonly name = 'SubmitExpiredAttempts';
  readonly policy = SUBMIT_EXPIRED_ATTEMPTS_POLICY;

  constructor(private readonly deps: ExpiryDependencies) {}

  async handle(command: SubmitExpiredAttempts, context: ApplicationContext): Promise<Result<ExpiryReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const now = this.deps.clock.now().toISOString();
    const expired = await this.deps.attempts.findExpired(now, command.limit ?? DEFAULT_LIMIT);
    if (!expired.ok) return err(fromAssessment(expired.error));

    const idle = await this.deps.attempts.findIdlePracticeRuns(new Date(Date.parse(now) - PRACTICE_IDLE_MS).toISOString(), command.limit ?? DEFAULT_LIMIT);
    if (!idle.ok) return err(fromAssessment(idle.error));

    const skipped: string[] = [];
    let submittedCount = 0;
    let runsFinished = 0;
    for (const attempt of [...expired.value, ...idle.value]) {
      const submitted = submitAttempt(attempt, { reason: 'expiry', idempotencyKey: `expiry:${attempt.attemptId}` }, now);
      if (!submitted.ok) {
        skipped.push(`${attempt.attemptId}: ${submitted.error.code}`);
        continue;
      }
      const event = attemptSubmittedEvent(attempt, 'expiry', now, context);
      const saved = await this.deps.attempts.save(submitted.value, 'in_progress', event);
      if (saved.ok) {
        submittedCount += 1;
        if (attempt.formId === null) runsFinished += 1;
      }
      else skipped.push(`${attempt.attemptId}: ${saved.error.code}`);
    }

    await this.deps.audit.record({
      principal: context.principal,
      action: 'SubmitExpiredAttempts',
      targetContext: 'assessment',
      targetType: 'attempt',
      targetId: context.correlationId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(Object.freeze({ asOf: now, submitted: submittedCount, runsFinished, skipped: Object.freeze(skipped) }));
  }
}
