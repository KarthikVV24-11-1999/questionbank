/**
 * The pre-check battery's closed vocabulary (AI-ARCHITECTURE §11).
 *
 * Twelve checks, each either **blocking** or **advisory**. A candidate that
 * fails a blocking check never reaches a reviewer; an advisory failure is
 * recorded and shown to the reviewer but does not stop acceptance.
 *
 * The identifiers are the stable names a verdict is stored and queried under —
 * never the document's prose, which may be reworded. The document's own row
 * number rides along so the two can be reconciled by eye.
 *
 * Closed in two directions. `PRECHECK_COUNT` below turns a thirteenth entry
 * (or a deleted one) into a compile error, and `PrecheckId` is derived from
 * the list, so a verdict naming anything else does not typecheck.
 */

export const PRECHECK_SEVERITIES = ['blocking', 'advisory'] as const;
export type PrecheckSeverity = (typeof PRECHECK_SEVERITIES)[number];

interface PrecheckDefinition {
  /** The row in the §11 table. */
  readonly number: number;
  readonly id: string;
  readonly severity: PrecheckSeverity;
}

export const PRECHECKS = [
  { number: 1, id: 'schema_validity', severity: 'blocking' },
  { number: 2, id: 'renderability', severity: 'blocking' },
  { number: 3, id: 'answer_verification', severity: 'blocking' },
  { number: 4, id: 'numeric_spec_completeness', severity: 'blocking' },
  { number: 5, id: 'syllabus_scope', severity: 'blocking' },
  { number: 6, id: 'item_solution_key_consistency', severity: 'blocking' },
  { number: 7, id: 'distractor_validity', severity: 'blocking' },
  { number: 8, id: 'duplicate_detection', severity: 'advisory' },
  { number: 9, id: 'difficulty_plausibility', severity: 'advisory' },
  { number: 10, id: 'ambiguity_clarity', severity: 'advisory' },
  { number: 11, id: 'safety_appropriateness', severity: 'blocking' },
  { number: 12, id: 'provenance_licensing_completeness', severity: 'blocking' },
] as const satisfies readonly PrecheckDefinition[];

export type PrecheckId = (typeof PRECHECKS)[number]['id'];

/** `never` unless the list holds exactly twelve, which makes the assignment fail to compile. */
export const PRECHECK_COUNT: (typeof PRECHECKS)['length'] extends 12 ? 12 : never = 12;

export const PRECHECK_IDS: readonly PrecheckId[] = Object.freeze(PRECHECKS.map((check) => check.id));

export function isPrecheckId(value: string): value is PrecheckId {
  return (PRECHECK_IDS as readonly string[]).includes(value);
}

export function precheckSeverity(id: PrecheckId): PrecheckSeverity {
  return PRECHECKS.find((check) => check.id === id)!.severity;
}

export const BLOCKING_PRECHECKS: readonly PrecheckId[] = Object.freeze(
  PRECHECKS.filter((check) => check.severity === 'blocking').map((check) => check.id),
);
