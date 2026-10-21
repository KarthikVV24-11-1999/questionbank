import { abandonAttempt } from '../../domain/attempt.js';
import type { AttemptRepository, FormRepository, ResponseLog } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { authorize, fromAssessment, type ApplicationError } from '../authorization.js';
import type { SweepWindows } from '../commands/form-commands.js';
import type { Handler } from '../handler-registry.js';
import { SWEEP_WINDOWS_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock } from '../ports.js';

export interface SweepDependencies {
  readonly forms: FormRepository;
  readonly attempts: AttemptRepository;
  readonly responses: ResponseLog;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

export interface SweepReport {
  readonly asOf: string;
  readonly formsOpened: number;
  readonly formsClosed: number;
  readonly attemptsAbandoned: number;
  /** Live attempts past their window that hold a response: those are submitted, never abandoned, and are not this sweep's to decide. */
  readonly attemptsLeftForSubmission: number;
  /** Moves that did not apply (another writer got there first, or the store refused), named so a retry knows what is left. */
  readonly skipped: readonly string[];
}

const DEFAULT_LIMIT = 200;

/**
 * Applies the clock to stored state. Nothing in the domain reads a clock, so a
 * form's `active` or `closed` and an attempt's abandonment are records that
 * something acted on a moment; this is that something.
 *
 * **It is a command, not a timer.** There is no scheduler (D36), so nothing
 * calls it on a schedule, and it has no route: it is what a scheduler will call,
 * the way `SweepReviewAgeing` is. It is idempotent — a second run over the same
 * moment finds nothing left to do — and one move failing does not stop the rest.
 */
export class SweepWindowsHandler implements Handler<SweepWindows, SweepReport> {
  readonly name = 'SweepWindows';
  readonly policy = SWEEP_WINDOWS_POLICY;

  constructor(private readonly deps: SweepDependencies) {}

  async handle(command: SweepWindows, context: ApplicationContext): Promise<Result<SweepReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const now = this.deps.clock.now().toISOString();
    const limit = command.limit ?? DEFAULT_LIMIT;
    const skipped: string[] = [];

    const toOpen = await this.deps.forms.findDueToOpen(now, limit);
    if (!toOpen.ok) return err(fromAssessment(toOpen.error));
    let formsOpened = 0;
    for (const form of toOpen.value) {
      const opened = await this.deps.forms.open(form.formId, now);
      if (opened.ok) formsOpened += 1;
      else skipped.push(`open ${form.formId}: ${opened.error.code}`);
    }

    const toClose = await this.deps.forms.findDueToClose(now, limit);
    if (!toClose.ok) return err(fromAssessment(toClose.error));
    let formsClosed = 0;
    for (const form of toClose.value) {
      const closed = await this.deps.forms.close(form.formId, now);
      if (closed.ok) formsClosed += 1;
      else skipped.push(`close ${form.formId}: ${closed.error.code}`);
    }

    const stale = await this.deps.attempts.findAbandonable(now, limit);
    if (!stale.ok) return err(fromAssessment(stale.error));
    let attemptsAbandoned = 0;
    let attemptsLeftForSubmission = 0;
    for (const attempt of stale.value) {
      const answered = await this.deps.responses.answeredSlotCount(attempt.attemptId);
      if (!answered.ok) {
        skipped.push(`abandon ${attempt.attemptId}: ${answered.error.code}`);
        continue;
      }
      if (answered.value > 0) {
        attemptsLeftForSubmission += 1;
        continue;
      }
      const abandoned = abandonAttempt(attempt, now, answered.value);
      if (!abandoned.ok) {
        skipped.push(`abandon ${attempt.attemptId}: ${abandoned.error.code}`);
        continue;
      }
      const saved = await this.deps.attempts.save(abandoned.value, attempt.state);
      if (saved.ok) attemptsAbandoned += 1;
      else skipped.push(`abandon ${attempt.attemptId}: ${saved.error.code}`);
    }

    await this.deps.audit.record({
      principal: context.principal,
      action: 'SweepWindows',
      targetContext: 'assessment',
      targetType: 'sweep',
      targetId: now,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(Object.freeze({ asOf: now, formsOpened, formsClosed, attemptsAbandoned, attemptsLeftForSubmission, skipped: Object.freeze(skipped) }));
  }
}
