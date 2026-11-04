/** Planted for `practice-rules.spec.ts` (M8-54): one consumer among several registered for both types, once spread and once named. Never imported by production code. */
declare const scoring: unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const saying: any;
export const consumers = new Map([
  ['AttemptSubmitted', [scoring, ...saying]],
  ['PracticeAttemptSubmitted', [saying]],
]);
