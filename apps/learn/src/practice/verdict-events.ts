import type { ScreenAnalytics } from '../analytics/emitter.js';
import type { Verdict } from '../api/schemas.js';

/**
 * `practice.item_answered` (M8-34, D112): said when the learner is *told* how an answer came out, because the outcome is the one field of the event only the server can give, and the device
 * does not guess it. An answer whose verdict could not be fetched (a run sat without a connection) is therefore not an event, and is the cost of not inventing an outcome; the answer itself is not lost,
 * it is in the response log and will be in the score.
 *
 * It is once for each answer the learner gave to a question, though the verdict may be asked for again whenever they come back to it: the first telling is the event. An answer the server could not judge
 * (`unattempted`, `indeterminate`) is not an outcome and says nothing. The facts beside the outcome are the session's: how long the question held them, how often the answer changed, whether they flagged it.
 * The question's difficulty is not on the device and is not sent.
 */
export interface AnswerFacts {
  readonly timeOnItemMs: number;
  readonly answerChanges: number;
  readonly flagged: boolean;
}

export function createVerdictReporter(analytics: ScreenAnalytics, attemptId: string): (slotId: string, answerKey: string, verdict: Verdict, facts: AnswerFacts) => void {
  const told = new Set<string>();
  return (slotId, answerKey, verdict, facts) => {
    if (verdict !== 'correct' && verdict !== 'incorrect') return;
    const key = `${slotId}:${answerKey}`;
    if (told.has(key)) return;
    told.add(key);
    analytics.emit('practice.item_answered', { outcome: verdict, time_on_item_ms: facts.timeOnItemMs, answer_changes: facts.answerChanges, was_flagged: facts.flagged }, { attempt_id: attemptId });
  };
}
