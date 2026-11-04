/** Planted for `practice-rules.spec.ts` (M8-25): the run's event carries a form, which a consumer for papers would dereference. Never imported by production code. */
export interface AttemptSubmitted {
  readonly eventType: 'AttemptSubmitted';
  readonly schemaVersion: 1;
  readonly payload: {
    readonly attemptId: string;
    readonly formId: string;
  };
}
export interface PracticeAttemptSubmitted {
  readonly eventType: 'PracticeAttemptSubmitted';
  readonly schemaVersion: 1;
  readonly payload: { readonly attemptId: string; readonly formId: string | null };
}
export const ASSESSMENT_EVENT_TYPES = ['AttemptSubmitted', 'PracticeAttemptSubmitted'] as const;
