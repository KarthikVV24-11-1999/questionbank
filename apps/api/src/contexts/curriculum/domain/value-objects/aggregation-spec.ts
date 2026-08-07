import { err, ok, type Result } from '../result.js';

/**
 * How item outcomes become sectional and total scores (ASSESSMENT-ENGINE §2.1).
 *
 * §2.1 places `aggregation` inside `MarkingRuleSet`. It lives here instead —
 * on `ExamProfileVersion`, beside the rule set rather than within it. The rule
 * set's hash exists to pin *what a response is worth*; aggregation decides
 * *which outcomes survive into a total*, which is a different question and one
 * the rule set never asks. Keeping it separate also means adding aggregation
 * reissues no published rule-set hash. See ADR-0006.
 */

export const SECTION_AGGREGATIONS = ['SUM'] as const;
export type SectionAggregation = (typeof SECTION_AGGREGATIONS)[number];

export const TOTAL_AGGREGATIONS = ['SUM_OF_SECTIONS'] as const;
export type TotalAggregation = (typeof TOTAL_AGGREGATIONS)[number];

export const ROUNDING_MODES = ['NONE', 'HALF_UP'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export interface RoundingSpec {
  readonly mode: RoundingMode;
  readonly decimalPlaces: number;
}

/**
 * NEET UG Section B presents 15 items and scores the best 10. Without this the
 * exam is scored wrong, so it ships in v1 rather than waiting.
 *
 * Ties are broken by the **lowest slot ordinal**: deterministic, and unable to
 * advantage one candidate over another arbitrarily.
 */
export interface BestOfSpec {
  readonly sectionOrdinal: number;
  readonly countScored: number;
}

export interface AggregationSpecData {
  readonly sectionAggregation: SectionAggregation;
  readonly totalAggregation: TotalAggregation;
  readonly bestOf?: readonly BestOfSpec[];
  readonly rounding: RoundingSpec;
  /** JEE Main and NEET both allow a negative total; clamping is opt-in, never assumed. */
  readonly floorAtZero: boolean;
}

/** Reproduces JEE Main's behaviour with no configuration at all. */
export const DEFAULT_AGGREGATION: AggregationSpecData = Object.freeze({
  sectionAggregation: 'SUM' as const,
  totalAggregation: 'SUM_OF_SECTIONS' as const,
  rounding: Object.freeze({ mode: 'NONE' as const, decimalPlaces: 0 }),
  floorAtZero: false,
});

export type AggregationSpecErrorCode =
  | 'SECTION_AGGREGATION_UNKNOWN'
  | 'TOTAL_AGGREGATION_UNKNOWN'
  | 'ROUNDING_MODE_UNKNOWN'
  | 'DECIMAL_PLACES_INVALID'
  | 'BEST_OF_SECTION_INVALID'
  | 'BEST_OF_COUNT_INVALID'
  | 'BEST_OF_SECTION_DUPLICATE';

export interface AggregationSpecError {
  readonly kind: 'Validation';
  readonly code: AggregationSpecErrorCode;
  readonly message: string;
}

function validationError(code: AggregationSpecErrorCode, message: string): AggregationSpecError {
  return { kind: 'Validation', code, message };
}

export interface CreateAggregationSpecProps {
  readonly sectionAggregation?: SectionAggregation;
  readonly totalAggregation?: TotalAggregation;
  readonly bestOf?: readonly BestOfSpec[];
  readonly rounding?: RoundingSpec;
  readonly floorAtZero?: boolean;
}

export function createAggregationSpec(
  props: CreateAggregationSpecProps = {},
): Result<AggregationSpecData, AggregationSpecError> {
  const sectionAggregation = props.sectionAggregation ?? DEFAULT_AGGREGATION.sectionAggregation;
  const totalAggregation = props.totalAggregation ?? DEFAULT_AGGREGATION.totalAggregation;
  const rounding = props.rounding ?? DEFAULT_AGGREGATION.rounding;

  if (!(SECTION_AGGREGATIONS as readonly string[]).includes(sectionAggregation)) {
    return err(validationError('SECTION_AGGREGATION_UNKNOWN', `unknown section aggregation "${sectionAggregation}"`));
  }
  if (!(TOTAL_AGGREGATIONS as readonly string[]).includes(totalAggregation)) {
    return err(validationError('TOTAL_AGGREGATION_UNKNOWN', `unknown total aggregation "${totalAggregation}"`));
  }
  if (!(ROUNDING_MODES as readonly string[]).includes(rounding.mode)) {
    return err(validationError('ROUNDING_MODE_UNKNOWN', `unknown rounding mode "${rounding.mode}"`));
  }
  if (!Number.isInteger(rounding.decimalPlaces) || rounding.decimalPlaces < 0) {
    return err(
      validationError('DECIMAL_PLACES_INVALID', `decimalPlaces must be an integer >= 0, got ${rounding.decimalPlaces}`),
    );
  }

  const bestOf = props.bestOf ?? [];
  const seenSections = new Set<number>();
  for (const entry of bestOf) {
    if (!Number.isInteger(entry.sectionOrdinal) || entry.sectionOrdinal < 1) {
      return err(
        validationError('BEST_OF_SECTION_INVALID', `bestOf sectionOrdinal must be an integer >= 1, got ${entry.sectionOrdinal}`),
      );
    }
    if (!Number.isInteger(entry.countScored) || entry.countScored < 1) {
      return err(
        validationError('BEST_OF_COUNT_INVALID', `bestOf countScored must be an integer >= 1, got ${entry.countScored}`),
      );
    }
    if (seenSections.has(entry.sectionOrdinal)) {
      return err(
        validationError('BEST_OF_SECTION_DUPLICATE', `section ${entry.sectionOrdinal} carries more than one bestOf rule`),
      );
    }
    seenSections.add(entry.sectionOrdinal);
  }

  return ok(
    Object.freeze({
      sectionAggregation,
      totalAggregation,
      ...(bestOf.length > 0 ? { bestOf: Object.freeze(bestOf.map((entry) => Object.freeze({ ...entry }))) } : {}),
      rounding: Object.freeze({ ...rounding }),
      floorAtZero: props.floorAtZero ?? DEFAULT_AGGREGATION.floorAtZero,
    }),
  );
}
