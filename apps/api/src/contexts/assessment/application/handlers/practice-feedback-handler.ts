import { projectLog } from '../../domain/response-log.js';
import type { AttemptRepository, ResponseLog } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, fromAssessment, type ApplicationError } from '../authorization.js';
import type { GetPracticeFeedback } from '../commands/attempt-commands.js';
import type { Handler } from '../handler-registry.js';
import { GET_PRACTICE_FEEDBACK_POLICY } from '../policies.js';
import type { ApplicationContext, ResponseJudge } from '../ports.js';
import { gate, ownAttempt } from './attempt-handlers.js';

/**
 * What a learner is told of one answer, in a practice run (M7-29). **Built field by field**, so a field marking gains next year does not cross unless
 * someone writes it here: the slot, and the word. Not the marks, not the rule's explanation, not the correct option, not the solution.
 */
export const FEEDBACK_OUTCOMES = ['correct', 'incorrect', 'unattempted', 'indeterminate'] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export interface PracticeFeedback {
  readonly attemptId: string;
  readonly slotId: string;
  readonly outcome: FeedbackOutcome;
}

export interface PracticeFeedbackDependencies {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
  readonly responses: Pick<ResponseLog, 'findByAttempt'>;
  readonly judge: ResponseJudge;
}

/**
 * Immediate feedback for the learner's own practice run.
 *
 * **It judges what was recorded.** The answer comes from the response log's projection, the same one scoring reads, so feedback and the eventual score
 * cannot disagree about what the learner answered; a slot with no answer is `unattempted` without anything being asked of marking.
 *
 * **Only a run that pinned immediate feedback gives it.** The pinned delivery document says so (`feedbackMode`), and a mock's says `deferred`: a mock
 * is not a practice run and gets no correctness before it is submitted, whatever the caller asks.
 *
 * What this surface is, and is not, for the key-free argument is set out in ADR-0050: correctness of the learner's own answer is served; the key, the
 * correct option, the rule and the solution are not.
 */
export class GetPracticeFeedbackHandler implements Handler<GetPracticeFeedback, PracticeFeedback> {
  readonly name = 'GetPracticeFeedback';
  readonly policy = GET_PRACTICE_FEEDBACK_POLICY;

  constructor(private readonly deps: PracticeFeedbackDependencies) {}

  async handle(query: GetPracticeFeedback, context: ApplicationContext): Promise<Result<PracticeFeedback, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);
    const owned = await ownAttempt(this.deps, query.attemptId, context);
    if (!owned.ok) return owned;
    const attempt = owned.value;

    if (attempt.mode !== 'practice' || attempt.deliveryPolicy['feedbackMode'] !== 'immediate') {
      return err(applicationError('RuleViolation', 'FEEDBACK_NOT_IMMEDIATE', 'only a practice run gives feedback while it is being sat', 'attemptId'));
    }
    if (attempt.state !== 'in_progress' && attempt.state !== 'submitted') {
      return err(applicationError('PreconditionFailed', 'ATTEMPT_NOT_STARTED', `a ${attempt.state} attempt has no answers to give feedback on`, 'state'));
    }
    if (!attempt.slots.some((slot) => slot.slotId === query.slotId)) {
      return err(applicationError('NotFound', 'NOT_FOUND', `no slot ${query.slotId} in this attempt`, 'slotId'));
    }

    const events = await this.deps.responses.findByAttempt(attempt.attemptId);
    if (!events.ok) return err(fromAssessment(events.error));
    const answer = projectLog(attempt, events.value).slots.find((slot) => slot.slot === query.slotId)?.answer;
    const give = (outcome: FeedbackOutcome): Result<PracticeFeedback, ApplicationError> =>
      ok(Object.freeze({ attemptId: attempt.attemptId, slotId: query.slotId, outcome }));
    if (answer === undefined || answer === null) return give('unattempted');

    const judged = await this.deps.judge.judge(attempt, query.slotId, answer, context);
    if (!judged.ok) return judged;
    return give((FEEDBACK_OUTCOMES as readonly string[]).includes(judged.value) ? (judged.value as FeedbackOutcome) : 'indeterminate');
  }
}
