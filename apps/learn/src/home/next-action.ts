import type { LearningApi } from '../api/learning-api.js';

/**
 * The one thing a learner is told to do next (M7-57, DEC-M7-33). It is chosen from what the server answers and by nothing else: what is due and what is weakest
 * are the server's answers (the review plan's order, the remediation route's order), and this module holds no threshold, no count and no score.
 *
 * The order is the roadmap's: **a concept escalated to remediation first**, because it is the one the schedule has stopped repeating; then what is
 * due, most overdue first as the plan gives it; then the weakest concept, if the screen has been told which taxonomy to ask about; then the report of
 * the last sitting, if there is one. A concept whose escalation was resolved is not in the plan (D85), so it is not here.
 *
 * The sources are asked in that order and the asking stops at the first that has an answer: a learner with an escalation has no use for the others.
 */
export type NextAction =
  | { readonly kind: 'practise'; readonly why: 'escalated' | 'due' | 'weakest'; readonly conceptIdentityId: string; readonly taxonomyVersionId: string }
  | { readonly kind: 'read-report'; readonly attemptId: string }
  | { readonly kind: 'nothing' };

export interface NextActionSources {
  readonly learning: LearningApi;
  /** Which taxonomy to ask the remediation route about; absent, "weakest" cannot be asked and is skipped. */
  readonly taxonomyVersionId: string | null;
  /** The attempt this device last sat, whose report is looked for last. */
  readonly lastAttemptId: string | null;
}

/** Whether a failure is the server saying there is no such thing, as opposed to the server being out of reach. */
export function isNotFound(error: unknown): boolean {
  return (error as { problem?: { status?: unknown } }).problem?.status === 404;
}

export async function chooseNextAction(sources: NextActionSources): Promise<NextAction> {
  const plan = await sources.learning.getReviewPlan();
  const escalated = plan.escalated[0];
  if (escalated !== undefined) return { kind: 'practise', why: 'escalated', conceptIdentityId: escalated.conceptIdentityId, taxonomyVersionId: escalated.taxonomyVersionId };
  const due = plan.due[0];
  if (due !== undefined) return { kind: 'practise', why: 'due', conceptIdentityId: due.conceptIdentityId, taxonomyVersionId: due.taxonomyVersionId };

  if (sources.taxonomyVersionId !== null) {
    const weakest = (await sources.learning.suggestRemediation(sources.taxonomyVersionId))[0];
    if (weakest !== undefined) return { kind: 'practise', why: 'weakest', conceptIdentityId: weakest, taxonomyVersionId: sources.taxonomyVersionId };
  }

  if (sources.lastAttemptId !== null) {
    try {
      await sources.learning.getReport(sources.lastAttemptId);
      return { kind: 'read-report', attemptId: sources.lastAttemptId };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { kind: 'nothing' };
}
