import type { Result } from './result.js';
import type { ScoringError } from './scoring-error.js';
import type { ScoreRecord } from './score-record.js';
import type { RescoringOperation } from './rescoring-operation.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows that Postgres exists.
 */

export type RepositoryError = ScoringError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export interface ScoreRecordRepository {
  /** One aggregate, one transaction: the record, its sections and its outcomes together. */
  save(record: ScoreRecord): Promise<Result<ScoreRecord, RepositoryError>>;

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
  save(operation: RescoringOperation): Promise<Result<RescoringOperation, RepositoryError>>;
  findById(operationId: string): Promise<Result<RescoringOperation, RepositoryError>>;
  findByState(state: RescoringOperation['state']): Promise<Result<readonly RescoringOperation[], RepositoryError>>;
}
