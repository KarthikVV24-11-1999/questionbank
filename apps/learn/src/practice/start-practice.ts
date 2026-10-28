import type { AssessmentApi } from '../api/assessment-api.js';
import type { AttemptDto } from '../api/schemas.js';

/**
 * How many questions a practice run starts with. A starting size the screen asks for, not a rule: the server holds the upper bound and refuses past it,
 * and nothing here classifies a learner or a concept by it.
 */
export const PRACTICE_RUN_SIZE = 10;

/**
 * The one tap (M7-58, DEC-M7-31): a concept to a started practice run, in one action. The run is about the concept and no other (a `filtered` selection scoped to
 * it, which is true of any finding or due concept; `targeted` is Learning's choice of the weakest few and would not be about this one unless it were among them),
 * and it is started, because a run that is created and not started has not begun.
 *
 * The key is the caller's and is the same on every try for one tap, so a tap retried after a failure between the two calls returns the run it made and does not
 * make another.
 */
export async function startPracticeOn(
  assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'startAttempt'>,
  request: { readonly examProfileVersionId: string; readonly conceptIdentityId: string; readonly idempotencyKey: string },
): Promise<AttemptDto> {
  const created = await assessment.createPracticeAttempt(
    { examProfileVersionId: request.examProfileVersionId, conceptIdentityIds: [request.conceptIdentityId], count: PRACTICE_RUN_SIZE },
    request.idempotencyKey,
  );
  return assessment.startAttempt(created.attemptId);
}
