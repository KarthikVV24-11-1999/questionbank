import { err, ok, type Result } from '../../domain/result.js';
import { rationalToDecimalString } from '../../domain/numeric/decimal.js';
import type { ScoreRecord } from '../../domain/score-record.js';
import type { RescoringOperationRepository, ScoreRecordRepository } from '../../domain/repository-ports.js';
import type { DryRunResult } from '../../domain/rescoring-dry-run.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext } from '../ports.js';
import type { Handler } from '../handler-registry.js';

/**
 * Read models. **No view here carries an answer key, a correct option or a
 * solution** (§9 rule 10) — a score is explained by naming the rule that
 * produced it, never by showing the learner what the answer was.
 *
 * Marks are rendered as decimal text so no consumer reads a mark through a
 * double.
 */

export interface ItemOutcomeView {
  readonly slotId: string;
  readonly sectionOrdinal: number;
  readonly slotOrdinal: number;
  readonly correctness: string;
  readonly marksAwarded: string;
  readonly marksAvailable: string;
  readonly ruleAppliedId: string;
  readonly explanation: string;
}

export interface SectionScoreView {
  readonly sectionOrdinal: number;
  readonly raw: string;
  readonly maxAvailable: string;
  readonly attemptedCount: number;
  readonly correctCount: number;
  readonly incorrectCount: number;
  readonly negativeMarksIncurred: string;
}

export interface ScoreRecordView {
  readonly scoreRecordId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly isCurrent: boolean;
  readonly markingRuleSetHash: string;
  readonly ruleSchemaVersion: number;
  readonly totalRaw: string;
  readonly totalMaxAvailable: string;
  readonly computedAt: string;
  readonly reasonForRescore?: string;
  readonly sectionScores: readonly SectionScoreView[];
  readonly itemOutcomes: readonly ItemOutcomeView[];
}

export function toScoreRecordView(record: ScoreRecord): ScoreRecordView {
  return Object.freeze({
    scoreRecordId: record.scoreRecordId,
    attemptId: record.attemptId,
    generation: record.generation,
    isCurrent: record.isCurrent,
    markingRuleSetHash: record.markingRuleSetHash,
    ruleSchemaVersion: record.ruleSchemaVersion,
    totalRaw: rationalToDecimalString(record.totalScore.raw),
    totalMaxAvailable: rationalToDecimalString(record.totalScore.maxAvailable),
    computedAt: record.computedAt,
    ...(record.reasonForRescore !== undefined ? { reasonForRescore: record.reasonForRescore } : {}),
    sectionScores: Object.freeze(
      record.sectionScores.map((section) =>
        Object.freeze({
          sectionOrdinal: section.sectionOrdinal,
          raw: rationalToDecimalString(section.raw),
          maxAvailable: rationalToDecimalString(section.maxAvailable),
          attemptedCount: section.attemptedCount,
          correctCount: section.correctCount,
          incorrectCount: section.incorrectCount,
          negativeMarksIncurred: rationalToDecimalString(section.negativeMarksIncurred),
        }),
      ),
    ),
    // The response snapshot is deliberately absent: a client already knows what
    // it submitted, and echoing it back widens the payload for nothing.
    itemOutcomes: Object.freeze(
      record.itemOutcomes.map((outcome) =>
        Object.freeze({
          slotId: outcome.slotId,
          sectionOrdinal: outcome.sectionOrdinal,
          slotOrdinal: outcome.slotOrdinal,
          correctness: outcome.correctness,
          marksAwarded: rationalToDecimalString(outcome.marksAwarded),
          marksAvailable: rationalToDecimalString(outcome.marksAvailable),
          ruleAppliedId: outcome.ruleApplied.ruleId,
          explanation: outcome.ruleApplied.explanation,
        }),
      ),
    ),
  });
}

export interface GetScoreRecord {
  readonly attemptId: string;
  /** The learner the attempt belongs to, so ownership can be checked. */
  readonly ownerUserId: string;
}

export interface ListScoreRecordGenerations {
  readonly attemptId: string;
  readonly ownerUserId: string;
}

export interface GetRescoringDryRun {
  readonly operationId: string;
}

export const GET_SCORE_RECORD_POLICY = policy('GetScoreRecord', ['learner', 'ops', 'admin']);
export const LIST_GENERATIONS_POLICY = policy('ListScoreRecordGenerations', ['learner', 'ops', 'admin']);
export const GET_DRY_RUN_POLICY = policy('GetRescoringDryRun', ['ops', 'admin']);

function authorizeRead(context: ApplicationContext, ownerUserId: string): Result<true, ApplicationError> {
  const isOperator = context.principal.roleContext.some((role) => role === 'ops' || role === 'admin');
  if (isOperator || context.principal.id === ownerUserId) return ok(true);
  return err(
    applicationError('Authorization', 'NOT_OWNER', 'a learner may read only their own score records'),
  );
}

export class GetScoreRecordHandler implements Handler<GetScoreRecord, ScoreRecordView> {
  readonly name = 'GetScoreRecord';
  readonly policy = GET_SCORE_RECORD_POLICY;

  constructor(private readonly records: ScoreRecordRepository) {}

  async handle(query: GetScoreRecord, context: ApplicationContext): Promise<Result<ScoreRecordView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const owned = authorizeRead(context, query.ownerUserId);
    if (!owned.ok) return err(owned.error);

    const found = await this.records.findCurrentByAttemptId(query.attemptId);
    if (!found.ok) {
      return err(applicationError('NotFound', found.error.code, found.error.message));
    }
    return ok(toScoreRecordView(found.value));
  }
}

export class ListScoreRecordGenerationsHandler
  implements Handler<ListScoreRecordGenerations, readonly ScoreRecordView[]>
{
  readonly name = 'ListScoreRecordGenerations';
  readonly policy = LIST_GENERATIONS_POLICY;

  constructor(private readonly records: ScoreRecordRepository) {}

  async handle(
    query: ListScoreRecordGenerations,
    context: ApplicationContext,
  ): Promise<Result<readonly ScoreRecordView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const owned = authorizeRead(context, query.ownerUserId);
    if (!owned.ok) return err(owned.error);

    const found = await this.records.findAllGenerationsByAttemptId(query.attemptId);
    if (!found.ok) {
      return err(applicationError('NotFound', found.error.code, found.error.message));
    }
    return ok(Object.freeze(found.value.map(toScoreRecordView)));
  }
}

export class GetRescoringDryRunHandler implements Handler<GetRescoringDryRun, DryRunResult> {
  readonly name = 'GetRescoringDryRun';
  readonly policy = GET_DRY_RUN_POLICY;

  constructor(private readonly operations: RescoringOperationRepository) {}

  async handle(query: GetRescoringDryRun, context: ApplicationContext): Promise<Result<DryRunResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.operations.findById(query.operationId);
    if (!found.ok) {
      return err(applicationError('NotFound', found.error.code, found.error.message));
    }
    const preview = found.value.dryRunResult;
    if (preview === undefined) {
      return err(
        applicationError('NotFound', 'NO_DRY_RUN', `re-score ${query.operationId} has not been previewed`),
      );
    }
    return ok(preview);
  }
}
