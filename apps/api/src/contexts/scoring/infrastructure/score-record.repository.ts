import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError, type ScoringError } from '../domain/scoring-error.js';
import type { RepositoryError, ScoreRecordRepository } from '../domain/repository-ports.js';
import type { ScoreRecord } from '../domain/score-record.js';
import type { ItemOutcome } from '../domain/item-outcome.js';
import type { SectionScore, TotalScore } from '../domain/aggregate-scores.js';
import type { ResponseSnapshot } from '../domain/scoring-input.js';
import { parseRational, rationalToDecimalString, type Rational } from '../domain/numeric/decimal.js';

/**
 * The casing boundary (§2): the database is `snake_case`, the domain is
 * `camelCase`, and the mapping happens here and nowhere else.
 *
 * **Marks cross as decimal text, never as a JavaScript number.** `numeric` in
 * Postgres is exact and `Rational` is exact; routing between them through a
 * double would silently reintroduce the error the whole numeric module exists
 * to avoid. `pg` returns `numeric` as a string for the same reason, and this
 * file keeps it that way.
 */

const MARKS_SCALE = 4;

function marksOut(value: Rational): string {
  return rationalToDecimalString(value, MARKS_SCALE);
}

function marksIn(value: string): Rational {
  const parsed = parseRational(value);
  if (!parsed.ok) {
    // `numeric` admits 'NaN', so this is reachable — by a row this repository
    // did not write. Infrastructure faults throw (§8); returning zero would
    // silently turn a corrupt row into a defensible-looking score of nothing.
    throw new Error(`scoring: stored mark "${value}" is not a number`);
  }
  return parsed.value;
}

interface ScoreRecordRow {
  readonly score_record_id: string;
  readonly attempt_id: string;
  readonly exam_profile_version_id: string;
  readonly marking_rule_set_hash: string;
  readonly rule_schema_version: number;
  readonly taxonomy_version_id: string;
  readonly generation: number;
  readonly is_current: boolean;
  readonly supersedes_score_record_id: string | null;
  readonly reason_for_rescore: string | null;
  readonly total_raw: string;
  readonly total_max_available: string;
  readonly total_attempted_count: number;
  readonly total_correct_count: number;
  readonly total_incorrect_count: number;
  readonly total_negative_marks: string;
  readonly computed_at: Date;
}

interface SectionRow {
  readonly section_ordinal: number;
  readonly raw: string;
  readonly max_available: string;
  readonly attempted_count: number;
  readonly correct_count: number;
  readonly incorrect_count: number;
  readonly negative_marks: string;
}

interface OutcomeRow {
  readonly slot_id: string;
  readonly slot_ordinal: number;
  readonly section_ordinal: number;
  readonly item_version_id: string;
  readonly response_snapshot: ResponseSnapshot | null;
  readonly correctness: ItemOutcome['correctness'];
  readonly marks_awarded: string;
  readonly marks_available: string;
  readonly rule_applied_id: string;
  readonly rule_applied_explanation: string;
}

function toTotalScore(row: ScoreRecordRow, maxAvailable: Rational): TotalScore {
  return Object.freeze({
    raw: marksIn(row.total_raw),
    maxAvailable,
    attemptedCount: row.total_attempted_count,
    correctCount: row.total_correct_count,
    incorrectCount: row.total_incorrect_count,
    negativeMarksIncurred: marksIn(row.total_negative_marks),
  });
}

function toSectionScore(row: SectionRow): SectionScore {
  return Object.freeze({
    sectionOrdinal: row.section_ordinal,
    raw: marksIn(row.raw),
    maxAvailable: marksIn(row.max_available),
    attemptedCount: row.attempted_count,
    correctCount: row.correct_count,
    incorrectCount: row.incorrect_count,
    negativeMarksIncurred: marksIn(row.negative_marks),
  });
}

function toItemOutcome(row: OutcomeRow): ItemOutcome {
  return Object.freeze({
    slotId: row.slot_id,
    sectionOrdinal: row.section_ordinal,
    slotOrdinal: row.slot_ordinal,
    itemVersionId: row.item_version_id,
    ...(row.response_snapshot !== null ? { responseSnapshot: row.response_snapshot } : {}),
    correctness: row.correctness,
    marksAwarded: marksIn(row.marks_awarded),
    marksAvailable: marksIn(row.marks_available),
    ruleApplied: Object.freeze({ ruleId: row.rule_applied_id, explanation: row.rule_applied_explanation }),
  });
}

function toScoreRecord(
  row: ScoreRecordRow,
  sections: readonly SectionRow[],
  outcomes: readonly OutcomeRow[],
): ScoreRecord {
  const sectionScores = sections.map(toSectionScore);
  return Object.freeze({
    scoreRecordId: row.score_record_id,
    attemptId: row.attempt_id,
    examProfileVersionId: row.exam_profile_version_id,
    taxonomyVersionId: row.taxonomy_version_id,
    markingRuleSetHash: row.marking_rule_set_hash,
    ruleSchemaVersion: row.rule_schema_version,
    generation: row.generation,
    isCurrent: row.is_current,
    ...(row.supersedes_score_record_id !== null
      ? { supersedesScoreRecordId: row.supersedes_score_record_id }
      : {}),
    totalScore: toTotalScore(row, marksIn(row.total_max_available)),
    sectionScores: Object.freeze(sectionScores),
    itemOutcomes: Object.freeze(outcomes.map(toItemOutcome)),
    computedAt: row.computed_at.toISOString(),
    ...(row.reason_for_rescore !== null ? { reasonForRescore: row.reason_for_rescore } : {}),
  });
}

/**
 * The profile and taxonomy identifiers ride on the record itself (ADR-0017)
 * — `examProfileVersionId` and `taxonomyVersionId` are part of what a score
 * *is*, not context supplied alongside it. A prior version of this class
 * took them at construction instead, which meant one instance could only
 * ever be correct for one exam profile; ADR-0017 records why that was wrong.
 */
export class PostgresScoreRecordRepository implements ScoreRecordRepository {
  constructor(private readonly pool: Pool) {}

  async save(record: ScoreRecord): Promise<Result<ScoreRecord, RepositoryError>> {
    return this.inTransaction(async (client) => {
      await this.insert(client, record, null);
      return record;
    });
  }

  async supersede(
    predecessorId: string,
    successor: ScoreRecord,
    rescoringOperationId?: string,
  ): Promise<Result<ScoreRecord, RepositoryError>> {
    return this.inTransaction(async (client) => {
      // Standing the predecessor down first is what lets the partial unique
      // index admit the successor. Both statements are in one transaction, so
      // an attempt is never left with no current record.
      await client.query(`UPDATE scoring.score_record SET is_current = false WHERE score_record_id = $1`, [
        predecessorId,
      ]);
      await this.insert(client, successor, rescoringOperationId ?? null);
      return successor;
    });
  }

  async findById(scoreRecordId: string): Promise<Result<ScoreRecord, RepositoryError>> {
    return this.loadOne(`SELECT * FROM scoring.score_record WHERE score_record_id = $1`, [scoreRecordId]);
  }

  async findCurrentByAttemptId(attemptId: string): Promise<Result<ScoreRecord, RepositoryError>> {
    return this.loadOne(`SELECT * FROM scoring.score_record WHERE attempt_id = $1 AND is_current`, [attemptId]);
  }

  async findAllGenerationsByAttemptId(
    attemptId: string,
  ): Promise<Result<readonly ScoreRecord[], RepositoryError>> {
    const found = await this.pool.query<ScoreRecordRow>(
      `SELECT * FROM scoring.score_record WHERE attempt_id = $1 ORDER BY generation`,
      [attemptId],
    );
    const records: ScoreRecord[] = [];
    for (const row of found.rows) {
      records.push(await this.hydrate(row));
    }
    return ok(Object.freeze(records));
  }

  private async loadOne(text: string, params: readonly unknown[]): Promise<Result<ScoreRecord, RepositoryError>> {
    const found = await this.pool.query<ScoreRecordRow>(text, [...params]);
    const row = found.rows[0];
    if (row === undefined) {
      return err(notFoundError('NOT_FOUND', 'no score record matches'));
    }
    return ok(await this.hydrate(row));
  }

  private async hydrate(row: ScoreRecordRow): Promise<ScoreRecord> {
    const sections = await this.pool.query<SectionRow>(
      `SELECT * FROM scoring.section_score WHERE score_record_id = $1 ORDER BY section_ordinal`,
      [row.score_record_id],
    );
    const outcomes = await this.pool.query<OutcomeRow>(
      `SELECT * FROM scoring.item_outcome WHERE score_record_id = $1
        ORDER BY section_ordinal, slot_ordinal`,
      [row.score_record_id],
    );
    return toScoreRecord(row, sections.rows, outcomes.rows);
  }

  private async insert(client: PoolClient, record: ScoreRecord, operationId: string | null): Promise<void> {
    await client.query(
      `INSERT INTO scoring.score_record
         (score_record_id, attempt_id, exam_profile_version_id, marking_rule_set_hash, rule_schema_version,
          taxonomy_version_id, generation, is_current, supersedes_score_record_id, rescoring_operation_id,
          reason_for_rescore, total_raw, total_max_available, total_attempted_count, total_correct_count,
          total_incorrect_count, total_negative_marks, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        record.scoreRecordId,
        record.attemptId,
        record.examProfileVersionId,
        record.markingRuleSetHash,
        record.ruleSchemaVersion,
        record.taxonomyVersionId,
        record.generation,
        record.isCurrent,
        record.supersedesScoreRecordId ?? null,
        operationId,
        record.reasonForRescore ?? null,
        marksOut(record.totalScore.raw),
        marksOut(record.totalScore.maxAvailable),
        record.totalScore.attemptedCount,
        record.totalScore.correctCount,
        record.totalScore.incorrectCount,
        marksOut(record.totalScore.negativeMarksIncurred),
        record.computedAt,
      ],
    );

    for (const section of record.sectionScores) {
      await client.query(
        `INSERT INTO scoring.section_score
           (score_record_id, section_ordinal, raw, max_available, attempted_count,
            correct_count, incorrect_count, negative_marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          record.scoreRecordId,
          section.sectionOrdinal,
          marksOut(section.raw),
          marksOut(section.maxAvailable),
          section.attemptedCount,
          section.correctCount,
          section.incorrectCount,
          marksOut(section.negativeMarksIncurred),
        ],
      );
    }

    for (const outcome of record.itemOutcomes) {
      await client.query(
        `INSERT INTO scoring.item_outcome
           (score_record_id, slot_id, slot_ordinal, section_ordinal, item_version_id, response_snapshot,
            correctness, marks_awarded, marks_available, rule_applied_id, rule_applied_explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          record.scoreRecordId,
          outcome.slotId,
          outcome.slotOrdinal,
          outcome.sectionOrdinal,
          outcome.itemVersionId,
          outcome.responseSnapshot === undefined ? null : JSON.stringify(outcome.responseSnapshot),
          outcome.correctness,
          marksOut(outcome.marksAwarded),
          marksOut(outcome.marksAvailable),
          outcome.ruleApplied.ruleId,
          outcome.ruleApplied.explanation,
        ],
      );
    }
  }

  /** One aggregate, one transaction (§10). A half-written score is not a score. */
  private async inTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<Result<T, RepositoryError>> {
    const client = await this.pool.connect();
    let outcome: Result<T, RepositoryError>;

    // No `finally`: the catch never rethrows, so the release below always runs
    // on both paths. A `finally` here would carry an abrupt-completion path
    // that nothing can reach, which is untestable code in the one place the
    // 100% rule matters most.
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      outcome = ok(value);
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(toRepositoryError(error));
    }

    client.release();
    return outcome;
  }
}

/**
 * `23505` is a unique violation — someone else got there first, which is a
 * Conflict rather than a fault. Everything else is the database refusing the
 * write, and the caller needs to know that rather than see an empty success.
 *
 * `String(error)` rather than an `instanceof` narrowing: pg always throws an
 * Error, so the alternative branch would be untestable code guarding against
 * something that cannot happen.
 */
function toRepositoryError(error: unknown): RepositoryError {
  const code = (error as { code?: string } | null)?.code;
  const message = String(error);

  if (code === '23505') {
    return conflictError('CONFLICT', 'a current score record already exists for this attempt');
  }
  return {
    kind: 'Conflict',
    code: 'PERSISTENCE_REJECTED',
    message,
  } satisfies ScoringError<'PERSISTENCE_REJECTED'>;
}
