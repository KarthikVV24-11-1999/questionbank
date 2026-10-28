/**
 * Whether a report says the paper was re-scored (M7-59, DEC-M7-32, D84). The report is labelled with the score record it was made for, and the attempt's result
 * names the record that stands now and which generation it is: when the two differ the report is of a score that has been replaced, and when they agree
 * and the generation is past the first the paper was re-scored and this is the report for the score that stands. Nothing else is claimed.
 */
export type RescoreLabel =
  | { readonly kind: 'replaced'; readonly generation: number }
  | { readonly kind: 'rescored'; readonly generation: number }
  | { readonly kind: 'none' };

export function rescoreLabel(report: { readonly scoreRecordId: string }, standing: { readonly scoreRecordId: string; readonly generation: number } | null): RescoreLabel {
  if (standing === null) return { kind: 'none' };
  if (standing.scoreRecordId !== report.scoreRecordId) return { kind: 'replaced', generation: standing.generation };
  return standing.generation > 1 ? { kind: 'rescored', generation: standing.generation } : { kind: 'none' };
}
