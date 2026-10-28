import type { AttemptRepository, ResponseLog } from '../../domain/repository-ports.js';
import { responseTimings, type SlotResponseTiming } from '../../domain/response-timing.js';
import { preconditionFailedError } from '../../domain/assessment-error.js';
import { err, ok, type Result } from '../../domain/result.js';
import { authorize, fromAssessment, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import type { ApplicationContext } from '../ports.js';

/**
 * `GetResponseTimings` — what Learning may ask assessment (M7-11): for one submitted attempt, per slot, the instant of the response that stands and
 * the slot's time on item. Identifiers, instants and durations; **no answer, no event payload, no kind**. The system's alone, with no route.
 *
 * Only a submitted attempt has a response that stands: before submission the log is still being written. Asking about any other is a precondition
 * failure rather than a partial answer.
 */
export const GET_RESPONSE_TIMINGS_POLICY = policy('GetResponseTimings', [ROLES.system]);

export interface GetResponseTimings {
  readonly attemptId: string;
}

/**
 * The learner is named because nothing else in the chain from a submission to a mastery update carries them: `AttemptScored` names the attempt and the score,
 * and the attempt is assessment's. An identifier, like the rest of what crosses.
 */
export interface ResponseTimingsView {
  readonly learnerRef: string;
  readonly slots: readonly SlotResponseTimingView[];
}

export interface SlotResponseTimingView {
  readonly slotRef: string;
  readonly itemVersionId: string;
  readonly respondedAt: string | null;
  /** When the learner gave up on the slot, if they did and nothing stands for it (M7-38). */
  readonly gaveUpAt: string | null;
  readonly timeOnItemMs: number;
  /** What the interval cap and unclosed visits cost that time (M7-45): without these, `timeOnItemMs` cannot be told from a slot that lost nothing. */
  readonly truncatedIntervals: number;
  readonly discardedMs: number;
  readonly unclosedVisits: number;
}

export interface ResponseTimingDependencies {
  readonly attempts: AttemptRepository;
  readonly responses: ResponseLog;
}

export class GetResponseTimingsHandler implements Handler<GetResponseTimings, ResponseTimingsView> {
  readonly name = 'GetResponseTimings';
  readonly policy = GET_RESPONSE_TIMINGS_POLICY;

  constructor(private readonly deps: ResponseTimingDependencies) {}

  async handle(query: GetResponseTimings, context: ApplicationContext): Promise<Result<ResponseTimingsView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const attempt = await this.deps.attempts.findById(query.attemptId);
    if (!attempt.ok) return err(fromAssessment(attempt.error));
    if (attempt.value.state !== 'submitted') {
      return err(fromAssessment(preconditionFailedError('ATTEMPT_NOT_SUBMITTED', `a ${attempt.value.state} attempt has no response standing`, 'state')));
    }

    const events = await this.deps.responses.findByAttempt(query.attemptId);
    if (!events.ok) return err(fromAssessment(events.error));

    return ok(Object.freeze({ learnerRef: attempt.value.studentId, slots: Object.freeze(responseTimings(attempt.value, events.value).map(toView)) }));
  }
}

/** Named field by field: a spread would carry whatever the source gains next year. */
function toView(timing: SlotResponseTiming): SlotResponseTimingView {
  return Object.freeze({
    slotRef: timing.slotId,
    itemVersionId: timing.itemVersionId,
    respondedAt: timing.respondedAt,
    gaveUpAt: timing.gaveUpAt,
    timeOnItemMs: timing.timeOnItemMs,
    truncatedIntervals: timing.truncatedIntervals,
    discardedMs: timing.discardedMs,
    unclosedVisits: timing.unclosedVisits,
  });
}
