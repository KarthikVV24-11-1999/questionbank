import { err, ok, type Result } from './result.js';
import { validationError, type ScoringError } from './scoring-error.js';
import type { ItemOutcome } from './item-outcome.js';
import type { SectionScore, TotalScore } from './aggregate-scores.js';

/**
 * One interpretation of an attempt under one rule set version (DOMAIN-MODEL
 * §7, D3).
 *
 * **Nothing here mutates.** There is no setter, and superseding returns a new
 * record while leaving the original exactly as it was. INV-11's dual-result
 * retention is therefore structural: retaining both generations is not a
 * feature someone must remember to implement, it is the only thing the type
 * permits.
 *
 * `computedAt` is supplied by the caller and never read from a clock here.
 * §3 requires the scoring function to be pure, and F45 checks it: a domain
 * that can read the time is a domain whose output depends on when it ran.
 */
export interface ScoreRecord {
  readonly scoreRecordId: string;
  readonly attemptId: string;
  /**
   * The pin (ADR-0017). A score without it is a number with no defensible
   * provenance — supersede depends on knowing what the predecessor was
   * scored under, and neither field is derivable from anything else on the
   * record.
   */
  readonly examProfileVersionId: string;
  readonly taxonomyVersionId: string;
  /** Pinned from the attempt, not from whatever rule set happens to be current (R2). */
  readonly markingRuleSetHash: string;
  readonly ruleSchemaVersion: number;
  readonly generation: number;
  readonly isCurrent: boolean;
  readonly supersedesScoreRecordId?: string;
  readonly totalScore: TotalScore;
  readonly sectionScores: readonly SectionScore[];
  readonly itemOutcomes: readonly ItemOutcome[];
  readonly computedAt: string;
  readonly reasonForRescore?: string;
}

export type ScoreRecordErrorCode =
  | 'SCORE_RECORD_ID_REQUIRED'
  | 'ATTEMPT_ID_REQUIRED'
  | 'EXAM_PROFILE_VERSION_ID_REQUIRED'
  | 'TAXONOMY_VERSION_ID_REQUIRED'
  | 'MARKING_RULE_SET_HASH_REQUIRED'
  | 'RULE_SCHEMA_VERSION_INVALID'
  | 'GENERATION_INVALID'
  | 'COMPUTED_AT_REQUIRED'
  | 'FIRST_GENERATION_SUPERSEDES_NOTHING'
  | 'RESCORE_REQUIRES_PREDECESSOR'
  | 'RESCORE_REQUIRES_REASON';

export type ScoreRecordError = ScoringError<ScoreRecordErrorCode>;

function invalid(code: ScoreRecordErrorCode, message: string): ScoreRecordError {
  return validationError(code, message);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export interface CreateScoreRecordProps {
  readonly scoreRecordId: string;
  readonly attemptId: string;
  readonly examProfileVersionId: string;
  readonly taxonomyVersionId: string;
  readonly markingRuleSetHash: string;
  readonly ruleSchemaVersion: number;
  readonly generation: number;
  readonly supersedesScoreRecordId?: string;
  readonly totalScore: TotalScore;
  readonly sectionScores: readonly SectionScore[];
  readonly itemOutcomes: readonly ItemOutcome[];
  readonly computedAt: string;
  readonly reasonForRescore?: string;
}

export function createScoreRecord(props: CreateScoreRecordProps): Result<ScoreRecord, ScoreRecordError> {
  if (isBlank(props.scoreRecordId)) return err(invalid('SCORE_RECORD_ID_REQUIRED', 'scoreRecordId is required'));
  if (isBlank(props.attemptId)) return err(invalid('ATTEMPT_ID_REQUIRED', 'attemptId is required'));
  if (isBlank(props.examProfileVersionId)) {
    return err(invalid('EXAM_PROFILE_VERSION_ID_REQUIRED', 'examProfileVersionId is required — a score must be pinned'));
  }
  if (isBlank(props.taxonomyVersionId)) {
    return err(invalid('TAXONOMY_VERSION_ID_REQUIRED', 'taxonomyVersionId is required — a score must be pinned'));
  }
  if (isBlank(props.markingRuleSetHash)) {
    return err(invalid('MARKING_RULE_SET_HASH_REQUIRED', 'markingRuleSetHash is required — a score must be pinned'));
  }
  if (!Number.isInteger(props.ruleSchemaVersion) || props.ruleSchemaVersion < 1) {
    return err(
      invalid('RULE_SCHEMA_VERSION_INVALID', `ruleSchemaVersion must be an integer >= 1, got ${props.ruleSchemaVersion}`),
    );
  }
  if (!Number.isInteger(props.generation) || props.generation < 1) {
    return err(invalid('GENERATION_INVALID', `generation must be an integer >= 1, got ${props.generation}`));
  }
  if (isBlank(props.computedAt)) return err(invalid('COMPUTED_AT_REQUIRED', 'computedAt is required'));

  if (props.generation === 1 && props.supersedesScoreRecordId !== undefined) {
    return err(
      invalid('FIRST_GENERATION_SUPERSEDES_NOTHING', 'the original score record supersedes nothing'),
    );
  }
  if (props.generation > 1) {
    if (props.supersedesScoreRecordId === undefined || isBlank(props.supersedesScoreRecordId)) {
      return err(invalid('RESCORE_REQUIRES_PREDECESSOR', `generation ${props.generation} must name what it supersedes`));
    }
    if (props.reasonForRescore === undefined || isBlank(props.reasonForRescore)) {
      return err(invalid('RESCORE_REQUIRES_REASON', 'a re-score must record why it happened'));
    }
  }

  return ok(
    Object.freeze({
      scoreRecordId: props.scoreRecordId,
      attemptId: props.attemptId,
      examProfileVersionId: props.examProfileVersionId,
      taxonomyVersionId: props.taxonomyVersionId,
      markingRuleSetHash: props.markingRuleSetHash,
      ruleSchemaVersion: props.ruleSchemaVersion,
      generation: props.generation,
      isCurrent: true,
      ...(props.supersedesScoreRecordId !== undefined
        ? { supersedesScoreRecordId: props.supersedesScoreRecordId }
        : {}),
      totalScore: props.totalScore,
      sectionScores: Object.freeze([...props.sectionScores]),
      itemOutcomes: Object.freeze([...props.itemOutcomes]),
      computedAt: props.computedAt,
      ...(props.reasonForRescore !== undefined ? { reasonForRescore: props.reasonForRescore } : {}),
    }),
  );
}

/**
 * The predecessor as it stands once a successor exists: still present, still
 * complete, no longer current. Returns a new record — the original is never
 * touched, so no code path can lose a generation.
 */
export function markSuperseded(record: ScoreRecord): ScoreRecord {
  return Object.freeze({ ...record, isCurrent: false });
}
