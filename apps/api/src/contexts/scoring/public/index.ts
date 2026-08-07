/**
 * The scoring context's only public surface. Commands, queries and events —
 * no aggregate, repository or infrastructure type (ENGINEERING-HANDBOOK §1,
 * §9 rule 1).
 *
 * Value objects consumers need cross as read-only DTO shapes. In particular
 * **no export here carries an answer key or a response payload** (§9 rule 10).
 */

// ── Commands ────────────────────────────────────────────────────────────────
export type {
  ApproveRescoring,
  DraftRescoring,
  ExecuteRescoring,
  RunRescoringDryRun,
  ScoreAttempt,
} from '../application/commands/scoring-commands.js';

// ── Queries ─────────────────────────────────────────────────────────────────
export type {
  GetRescoringDryRun,
  GetScoreRecord,
  ItemOutcomeView,
  ListScoreRecordGenerations,
  ScoreRecordView,
  SectionScoreView,
} from '../application/queries/scoring-queries.js';

// ── Events ──────────────────────────────────────────────────────────────────
export type {
  AttemptScored,
  AttemptScoredPayload,
  AttemptsRescored,
  AttemptsRescoredPayload,
  ScoringEvent,
  ScoringEventType,
} from '../domain/events/scoring-events.js';

export { SCORING_EVENT_TYPES } from '../domain/events/scoring-events.js';

// ── The input contract ──────────────────────────────────────────────────────
//
// M3 stores a response specification on `ItemVersion`; M6 assembles those into
// an attempt. Both need these shapes, and `m3-seam.spec.ts` is written against
// this barrel alone so the seam breaks the build rather than breaking later.

export type {
  CreateScoredSection,
  CreateScoredSlot,
  CreateScoringInputProps,
  MatchedPair,
  ResponseSnapshot,
  ScoredSection,
  ScoredSlot,
  ScoringInput,
  ScoringPin,
  SlotOverride,
} from '../domain/scoring-input.js';

/** The answer key as authored data (what an `ItemVersion` holds). */
export type { CreateAnswerKeyProps as AnswerKeyData, AnswerKey, AnswerKeyKind } from '../domain/answer-key.js';

/** The numeric specification (D-001), mirroring the curriculum barrel's shape. */
export type {
  AnswerForm,
  ComparisonMode,
  NumericAnswerSpecData,
  NumericAnswerSpecResolved,
  UnitSpec,
} from '../domain/answer-key.js';

export type { Correctness, ItemOutcome, RuleAttribution } from '../domain/item-outcome.js';
export type { ScoreRecord } from '../domain/score-record.js';

/** An exact mark. Never a double — see ADR-0007. */
export type { Rational as Marks } from '../domain/numeric/decimal.js';

// ── Construction, so a consumer never hand-builds an unvalidated input ──────
export { createAnswerKey } from '../domain/answer-key.js';
export { createScoringInput } from '../domain/scoring-input.js';

/** Renders a mark for display or transport. */
export { rationalToDecimalString as marksToDecimalString } from '../domain/numeric/decimal.js';

// ── Value objects consumers need, as read-only data ─────────────────────────

/** The dry-run preview an operator approves (DOMAIN-MODEL §7). */
export type {
  DryRunResult,
  RankMovement,
  ScoreDelta,
  ScoreDeltaDistribution,
} from '../domain/rescoring-dry-run.js';
