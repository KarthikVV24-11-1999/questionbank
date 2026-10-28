import type { Result } from './result.js';
import type { ScoringError } from './scoring-error.js';
import type { ScoreRecord } from './score-record.js';
import type { RescoringOperation } from './rescoring-operation.js';
import type { AttemptScored, AttemptsRescored, AttemptScoreSuperseded } from './events/scoring-events.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows that Postgres exists.
 */

export type RepositoryError = ScoringError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export interface ScoreRecordRepository {
  /**
   * One aggregate, one transaction: the record, its sections and its outcomes together — and the event that describes
   * them (DEC-M7-6). A record with no event, or an event with no record, is not a state this port can produce.
   */
  save(record: ScoreRecord, event?: AttemptScored): Promise<Result<ScoreRecord, RepositoryError>>;

  /**
   * Stands the current record down and inserts its successor in one
   * transaction. Both generations survive; neither is ever rewritten.
   */
  supersede(
    predecessorId: string,
    successor: ScoreRecord,
    rescoringOperationId?: string,
  ): Promise<Result<ScoreRecord, RepositoryError>>;

  findById(scoreRecordId: string): Promise<Result<ScoreRecord, RepositoryError>>;
  findCurrentByAttemptId(attemptId: string): Promise<Result<ScoreRecord, RepositoryError>>;
  /** Every generation, oldest first. */
  findAllGenerationsByAttemptId(attemptId: string): Promise<Result<readonly ScoreRecord[], RepositoryError>>;
}

export interface RescoringOperationRepository {
  /** The completion's event rides the same transaction as the state change it reports (DEC-M7-6). */
  save(operation: RescoringOperation, event?: AttemptsRescored): Promise<Result<RescoringOperation, RepositoryError>>;
  /**
   * Completes a re-score: every predecessor stood down, every successor written, the operation `completed` and every event — one per attempt and the
   * operation's own — in **one transaction** (D72, ADR-0053). A correction that commits without its announcement is the defect `save(record, event)` closed
   * for a first score, one layer up; there is no partial re-score for this port to produce.
   */
  completeWithSuccessors(
    operation: RescoringOperation,
    supersessions: readonly { readonly predecessorId: string; readonly successor: ScoreRecord }[],
    events: readonly (AttemptsRescored | AttemptScoreSuperseded)[],
  ): Promise<Result<RescoringOperation, RepositoryError>>;
  findById(operationId: string): Promise<Result<RescoringOperation, RepositoryError>>;
  findByState(state: RescoringOperation['state']): Promise<Result<readonly RescoringOperation[], RepositoryError>>;
}
