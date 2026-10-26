/**
 * The weight of what a learner downloads to sit a paper (M6-58). The page is opened on a phone, often over a poor link, so the number
 * that matters is the bytes that cross it — compressed — and the bytes the device then has to parse. Both are held to a budget, and
 * the budget is held close to what was measured, so it cannot drift loose a little at a time.
 */
export interface BundleBudget {
  /** What the build weighed when the budget was last set. */
  readonly baseline: { readonly rawBytes: number; readonly gzipBytes: number };
  /** The most the build may weigh. */
  readonly budget: { readonly rawBytes: number; readonly gzipBytes: number };
  /** The largest the budget may stand above the baseline, as a ratio: a budget is raised by editing the baseline, with a reason. */
  readonly maxHeadroom: number;
  readonly why: string;
}

export interface Measured {
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export type BudgetFault = 'RAW_OVER_BUDGET' | 'GZIP_OVER_BUDGET' | 'BUDGET_LOOSER_THAN_THE_HEADROOM_ALLOWS' | 'BASELINE_ABOVE_BUDGET';

export function checkBudget(measured: Measured, spec: BundleBudget): BudgetFault[] {
  const faults: BudgetFault[] = [];
  if (measured.rawBytes > spec.budget.rawBytes) faults.push('RAW_OVER_BUDGET');
  if (measured.gzipBytes > spec.budget.gzipBytes) faults.push('GZIP_OVER_BUDGET');
  if (spec.budget.rawBytes > spec.baseline.rawBytes * spec.maxHeadroom || spec.budget.gzipBytes > spec.baseline.gzipBytes * spec.maxHeadroom) {
    faults.push('BUDGET_LOOSER_THAN_THE_HEADROOM_ALLOWS');
  }
  if (spec.baseline.rawBytes > spec.budget.rawBytes || spec.baseline.gzipBytes > spec.budget.gzipBytes) faults.push('BASELINE_ABOVE_BUDGET');
  return faults;
}
