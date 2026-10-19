import { err, ok, type Result } from './result.js';
import { preconditionFailedError, validationError, type GenerationError } from './generation-error.js';

/**
 * `AIBudget` — the ceiling on what one feature's runs may reserve in one period
 * (AI-ARCHITECTURE §14: budget checked at enqueue, before dispatch).
 *
 * **The unit is tokens**, not currency. A provider reports tokens; turning them
 * into money needs a price per model version, which is registry data this
 * milestone does not hold (D47). A ceiling in tokens is a real ceiling today and
 * converts cleanly the day a price exists.
 *
 * **The period is a UTC calendar month**, taken from a run's `requestedAt`, so
 * which budget a run is charged to is a fact about the run and never about when
 * a query happened to execute.
 *
 * Admission is arithmetic and nothing else: this module holds the one definition
 * of "fits", and persistence supplies the figures it is applied to.
 */

/** The one feature that spends today. The scope of a budget is a feature and a period. */
export const GENERATION_FEATURE = 'generation';

export interface AIBudget {
  readonly feature: string;
  /** `YYYY-MM`, UTC. */
  readonly period: string;
  readonly ceilingTokens: number;
}

export type AIBudgetErrorCode = 'BUDGET_FEATURE_INVALID' | 'BUDGET_PERIOD_INVALID' | 'BUDGET_CEILING_INVALID';

export type AdmissionErrorCode = 'BUDGET_NOT_DECLARED' | 'RUN_EXCEEDS_BUDGET';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const UTC_TIMESTAMP = /^(\d{4}-\d{2})-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A reservation or ceiling is a whole, positive, safely-representable number of tokens. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The period a UTC ISO-8601 timestamp (milliseconds form) falls in, or `undefined` for anything else. */
export function periodOf(timestamp: string): string | undefined {
  const match = UTC_TIMESTAMP.exec(timestamp);
  return match === null ? undefined : (match[1] as string);
}

export function createAIBudget(props: AIBudget): Result<AIBudget, GenerationError<AIBudgetErrorCode>> {
  if (typeof props.feature !== 'string' || props.feature.trim().length === 0) {
    return err(validationError('BUDGET_FEATURE_INVALID', 'a budget names the feature it governs', 'feature'));
  }
  if (typeof props.period !== 'string' || !PERIOD.test(props.period)) {
    return err(validationError('BUDGET_PERIOD_INVALID', 'a budget period is a UTC calendar month, YYYY-MM', 'period'));
  }
  if (!isTokenCount(props.ceilingTokens)) {
    return err(validationError('BUDGET_CEILING_INVALID', 'a budget ceiling is a positive whole number of tokens', 'ceilingTokens'));
  }
  return ok(Object.freeze({ feature: props.feature, period: props.period, ceilingTokens: props.ceilingTokens }));
}

export interface AdmissionFigures {
  readonly ceilingTokens: number;
  /** What the period's already-admitted runs have reserved between them. */
  readonly committedTokens: number;
  /** What the run asking to start would reserve. */
  readonly requestedTokens: number;
}

/**
 * Whether a run fits. It fits when everything already reserved plus what it asks
 * for does not exceed the ceiling — exactly equal fits, one token over does not.
 * The refusal carries all three figures so the caller can see what would have to
 * change, not only that something did.
 */
export function admitRun(figures: AdmissionFigures): Result<true, GenerationError<'RUN_EXCEEDS_BUDGET'>> {
  const { ceilingTokens, committedTokens, requestedTokens } = figures;
  if (committedTokens + requestedTokens > ceilingTokens) {
    return err(
      preconditionFailedError(
        'RUN_EXCEEDS_BUDGET',
        `the run asks for ${requestedTokens} tokens and ${committedTokens} of the period's ${ceilingTokens} are already reserved: ${Math.max(0, ceilingTokens - committedTokens)} remain`,
        'budgetTokens',
      ),
    );
  }
  return ok(true);
}

export function budgetNotDeclared(feature: string, period: string): GenerationError<'BUDGET_NOT_DECLARED'> {
  return preconditionFailedError(
    'BUDGET_NOT_DECLARED',
    `no ${feature} budget is declared for ${period}, and a period with no budget has no ceiling to admit a run against`,
    'period',
  );
}
