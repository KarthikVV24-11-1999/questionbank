/**
 * How outcomes become totals, as the executor reads it (ADR-0006).
 *
 * Mirrored structurally from `curriculum/public/` for the same reason as
 * `MarkingRuleSetData`: `domain/` imports nothing (§9 rule 2).
 * `aggregate-scores.spec.ts` asserts the barrel type stays assignable.
 *
 * Curriculum owns authoring and validation; Scoring only applies it.
 */

export type SectionAggregation = 'SUM';
export type TotalAggregation = 'SUM_OF_SECTIONS';
export type RoundingMode = 'NONE' | 'HALF_UP';

export interface RoundingSpec {
  readonly mode: RoundingMode;
  readonly decimalPlaces: number;
}

export interface BestOfSpec {
  readonly sectionOrdinal: number;
  readonly countScored: number;
}

export interface AggregationSpecData {
  readonly sectionAggregation: SectionAggregation;
  readonly totalAggregation: TotalAggregation;
  readonly bestOf?: readonly BestOfSpec[];
  readonly rounding: RoundingSpec;
  readonly floorAtZero: boolean;
}

/** Reproduces JEE Main with no configuration, matching the curriculum default. */
export const DEFAULT_AGGREGATION: AggregationSpecData = Object.freeze({
  sectionAggregation: 'SUM' as const,
  totalAggregation: 'SUM_OF_SECTIONS' as const,
  rounding: Object.freeze({ mode: 'NONE' as const, decimalPlaces: 0 }),
  floorAtZero: false,
});
