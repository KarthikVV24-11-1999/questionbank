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

/**
 * How many questions the diagnostic is (M8-32, FR-STU-03 rule 1: fixed length). Ten, because a learner reads and answers a question of this exam in about 45 to 60 seconds, so ten is at most eight to ten
 * minutes at the slowest and leaves room in the ten-minute journey (M8's first criterion) for the steps before it; fewer would name too few topics to say anything of where they stand, and more would spend the
 * time the criterion gives on the questions. It is a product judgement and the first one to revisit when the journey is measured with people.
 */
export const DIAGNOSTIC_LENGTH = 10;

/**
 * The one tap that starts the diagnostic: a short run taken breadth-first across what the learner declared they have studied, started the way any run is. It is the practice-run route with the `breadth`
 * strategy; the server makes no distinction between a diagnostic and any other breadth run, and which learner is offered one is `chooseNextAction`'s decision alone.
 */
export async function startDiagnosticOn(
  assessment: Pick<AssessmentApi, 'createDiagnosticAttempt' | 'startAttempt'>,
  request: { readonly examProfileVersionId: string; readonly idempotencyKey: string },
): Promise<AttemptDto> {
  const created = await assessment.createDiagnosticAttempt({ examProfileVersionId: request.examProfileVersionId, count: DIAGNOSTIC_LENGTH }, request.idempotencyKey);
  return assessment.startAttempt(created.attemptId);
}
