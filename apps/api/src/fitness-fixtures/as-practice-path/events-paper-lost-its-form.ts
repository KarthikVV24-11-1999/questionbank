/** Planted for `practice-rules.spec.ts` (M8-25): the paper's event made nullable, the other way to do this. Never imported by production code. */
export interface AttemptSubmitted {
  readonly eventType: 'AttemptSubmitted';
  readonly schemaVersion: 2;
  readonly payload: { readonly attemptId: string; readonly formId: string | null };
}
export interface PracticeAttemptSubmitted {
  readonly eventType: 'PracticeAttemptSubmitted';
  readonly schemaVersion: 1;
  readonly payload: { readonly attemptId: string };
}
export const ASSESSMENT_EVENT_TYPES = ['AttemptSubmitted', 'PracticeAttemptSubmitted'] as const;
