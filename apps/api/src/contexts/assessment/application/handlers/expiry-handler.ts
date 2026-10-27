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
  readonly submitted: number;
  /** Moves that did not apply (another writer got there first, or the store refused), named so a retry knows what is left. */
  readonly skipped: readonly string[];
}

const DEFAULT_LIMIT = 200;

/**
 * Submits the attempts whose deadline has passed and whose device never came back to say so (M6-42, D36). A window closing does not do this for attempts already running in it: debt D64.
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

    const skipped: string[] = [];
    let submittedCount = 0;
    for (const attempt of expired.value) {
      const submitted = submitAttempt(attempt, { reason: 'expiry', idempotencyKey: `expiry:${attempt.attemptId}` }, now);
      if (!submitted.ok) {
        skipped.push(`${attempt.attemptId}: ${submitted.error.code}`);
        continue;
      }
      const event = attemptSubmittedEvent(attempt, 'expiry', now, context);
      const saved = await this.deps.attempts.save(submitted.value, 'in_progress', event);
      if (saved.ok) submittedCount += 1;
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
    return ok(Object.freeze({ asOf: now, submitted: submittedCount, skipped: Object.freeze(skipped) }));
  }
}
