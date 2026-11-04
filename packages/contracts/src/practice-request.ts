/**
 * The body of the one request that starts a practice run about concepts (M7-58, DEC-M7-31). The learner app sends it and the API's end-to-end test sends it, from this
 * one function, so the tap the screens make and the tap the test proves cannot drift into two requests.
 *
 * The selection is `filtered`, scoped to the concepts named, which is about those concepts and no others for any concept. The `targeted` strategy is
 * Learning's choice of the weakest few and would be about a given concept only if it were among them.
 */
export interface PracticeRunInput {
  readonly examProfileVersionId: string;
  readonly conceptIdentityIds: readonly string[];
  readonly count: number;
}

export function practiceRunBody(input: PracticeRunInput) {
  return {
    examProfileVersionId: input.examProfileVersionId,
    selectionStrategy: 'filtered' as const,
    scopeFilter: { conceptIdentityIds: [...input.conceptIdentityIds] },
    count: input.count,
  };
}

/**
 * The body of the request that starts the diagnostic (M8-32, FR-STU-03): the same practice-run route, with the `breadth` strategy and no concept named, because the concepts are the ones the
 * learner declared they have studied and the server already holds them. There is no second way to make an attempt, and no word in the request that says "diagnostic": the server knows a strategy,
 * and which learner is offered it is the app's decision (`apps/learn/src/home/next-action.ts`).
 */
export interface DiagnosticRunInput {
  readonly examProfileVersionId: string;
  readonly count: number;
}

export function diagnosticRunBody(input: DiagnosticRunInput) {
  return { examProfileVersionId: input.examProfileVersionId, selectionStrategy: 'breadth' as const, count: input.count };
}
