/** Planted for `practice-rules.spec.ts` (M8-25): one consumer registered for both types, so a mock's consumer is handed a run. Never imported by production code. */
declare const scoring: unknown;
export const consumers = new Map([
  ['AttemptSubmitted', [scoring]],
  ['PracticeAttemptSubmitted', [scoring]],
]);
