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

/**
 * The item types the executor can score, and the key variant each requires.
 *
 * **Closed.** Adding one is a deliberate, reviewed change in `answer-key.ts` —
 * a new item type is a new way for an answer to be right, and there is no
 * data-only expression of that.
 *
 * Exported because Content owns the other end of the same vocabulary and must
 * be able to prove the two agree. Without it, a type added on one side and not
 * the other is discovered when a real attempt fails to score. This is the
 * widening the M2 close-out's seam spec exists to force, and it carries no key
 * material — it is a map of type names to variant names.
 */
export { KEY_KIND_BY_ITEM_TYPE, isKnownItemType } from '../domain/answer-key.js';
export type { KnownItemType } from '../domain/answer-key.js';

/**
 * Whether a response is exactly what a key calls correct — the executor's own
 * `EXACT_MATCH`, three-valued.
 *
 * Exported because Content must verify that a solution's stated final answer
 * agrees with the item's key (M3-14, DOMAIN-MODEL §5), and that verdict has to
 * mean what it will mean at scoring time. A comparison written in Content that
 * resembled this one would disagree the first time a tolerance, a unit rule or
 * an accepted answer form was involved — and it would disagree silently, on
 * the exact path that exists to prevent a learner being marked wrong for
 * answering what the solution taught.
 *
 * `indeterminate` is meaningful here and must not be read as agreement: a
 * solution that omits a unit the specification requires is one the executor
 * could not mark correct either.
 */
export { evaluateExactness as evaluateExactMatch } from '../domain/conditions/evaluate-condition.js';
export type { ConditionOutcome } from '../domain/conditions/evaluate-condition.js';

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
