import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { createAnswerKey, type AnswerKey } from '../domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../domain/aggregation-data.js';
import { createScoringInput, type ResponseSnapshot, type CreateScoredSlot } from '../domain/scoring-input.js';
import { scoreAttempt } from '../domain/score-attempt.js';
import { markSuperseded, type ScoreRecord } from '../domain/score-record.js';
import { makeRational, parseRational, rationalToDecimalString } from '../domain/numeric/decimal.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { PostgresScoreRecordRepository } from './score-record.repository.js';

let database: TestDatabase;
let repository: PostgresScoreRecordRepository;

const HASH = '4fe24605633c';
const PROFILE_ID = randomUUID();
const TAXONOMY_ID = randomUUID();
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  repository = new PostgresScoreRecordRepository(database.pool, {
    examProfileVersionId: PROFILE_ID,
    taxonomyVersionId: TAXONOMY_ID,
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

function slot(slotId: string, ordinal: number, response: ResponseSnapshot | undefined, marks = 4): CreateScoredSlot {
  return {
    slotId,
    ordinal,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: randomUUID(),
    marksAvailable: marks,
    answerKey: key,
    ...(response !== undefined ? { response } : {}),
  };
}

const chose = (id: string): ResponseSnapshot => ({ kind: 'OPTION_SELECTION', optionIds: [id] });

function build(attemptId: string, scoreRecordId: string, slots: readonly CreateScoredSlot[][]): ScoreRecord {
  const input = expectValue(
    createScoringInput({
      attemptId,
      pin: {
        examProfileVersionId: PROFILE_ID,
        markingRuleSetHash: HASH,
        ruleSchemaVersion: 1,
        taxonomyVersionId: TAXONOMY_ID,
        itemVersionIds: [randomUUID()],
      },
      sections: slots.map((sectionSlots, index) => ({ ordinal: index + 1, slots: sectionSlots })),
      overrides: [],
    }),
  );
  return expectValue(
    scoreAttempt({
      input,
      ruleSet: JEE_MAIN_RULE_SET,
      ruleSetHash: HASH,
      aggregation: DEFAULT_AGGREGATION,
      computedAt: '2026-08-07T00:00:00.000Z',
      scoreRecordId,
    }),
  );
}

describe('save and load round trip', () => {
  it('reconstitutes an identical aggregate', async () => {
    const attemptId = randomUUID();
    const record = build(attemptId, randomUUID(), [
      [slot('a', 1, chose('B')), slot('b', 2, chose('A')), slot('c', 3, undefined)],
      [slot('d', 1, chose('B'))],
    ]);

    expectValue(await repository.save(record));
    const loaded = expectValue(await repository.findById(record.scoreRecordId));

    expect(loaded).toEqual(record);
  });

  it('reconstitutes the outcomes in paper order', async () => {
    const attemptId = randomUUID();
    const record = build(attemptId, randomUUID(), [
      [slot('a', 1, chose('B')), slot('b', 2, chose('A'))],
      [slot('c', 1, chose('B')), slot('d', 2, undefined)],
    ]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(loaded.itemOutcomes.map((outcome) => outcome.slotId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps every rule attribution', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B')), slot('b', 2, chose('A'))]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(loaded.itemOutcomes.map((outcome) => outcome.ruleApplied)).toEqual([
      { ruleId: 'correct', explanation: 'correct → +4 marks' },
      { ruleId: 'incorrect', explanation: 'incorrect → −1 mark' },
    ]);
  });

  it('keeps an absent response absent rather than storing an empty one', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, undefined)]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(loaded.itemOutcomes[0]?.responseSnapshot).toBeUndefined();
    expect(loaded.itemOutcomes[0]?.correctness).toBe('unattempted');
  });

  it('round trips a stored response payload', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B'))]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(loaded.itemOutcomes[0]?.responseSnapshot).toEqual({ kind: 'OPTION_SELECTION', optionIds: ['B'] });
  });

  it('reports a missing record rather than inventing one', async () => {
    expect(expectError(await repository.findById(randomUUID())).kind).toBe('NotFound');
  });
});

describe('marks survive the round trip as exact decimals', () => {
  it('preserves a whole-number total', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B')), slot('b', 2, chose('A'))]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(rationalToDecimalString(loaded.totalScore.raw)).toBe('3');
  });

  it('preserves a negative total', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(rationalToDecimalString(loaded.totalScore.raw)).toBe('-1');
  });

  it('preserves a fractional mark exactly, not as the nearest double', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B'), 2.5)]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(rationalToDecimalString(loaded.itemOutcomes[0]?.marksAvailable ?? makeRational(0n, 1n))).toBe('2.5');
  });

  it('preserves a mark at the column scale', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B'), 0.0625)]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(rationalToDecimalString(loaded.itemOutcomes[0]?.marksAvailable ?? makeRational(0n, 1n))).toBe('0.0625');
  });

  it('returns marks as exact rationals, never as JavaScript numbers', async () => {
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B'))]]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    expect(typeof loaded.totalScore.raw.num).toBe('bigint');
    expect(typeof loaded.totalScore.raw.den).toBe('bigint');
  });

  it('preserves the section tallies', async () => {
    const record = build(randomUUID(), randomUUID(), [
      [slot('a', 1, chose('B')), slot('b', 2, chose('A')), slot('c', 3, undefined)],
    ]);
    expectValue(await repository.save(record));

    const loaded = expectValue(await repository.findById(record.scoreRecordId));
    const section = loaded.sectionScores[0];
    expect(section?.correctCount).toBe(1);
    expect(section?.incorrectCount).toBe(1);
    expect(section?.attemptedCount).toBe(2);
    expect(rationalToDecimalString(section?.negativeMarksIncurred ?? makeRational(0n, 1n))).toBe('1');
  });
});

describe('one aggregate, one transaction', () => {
  it('writes nothing at all when a detail row is rejected', async () => {
    const attemptId = randomUUID();
    const record = build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]);

    // Two outcomes on the same slot violate item_outcome_slot_unique, so the
    // insert of the second must take the whole record down with it.
    const broken: ScoreRecord = {
      ...record,
      itemOutcomes: [...record.itemOutcomes, ...record.itemOutcomes],
    };

    expect((await repository.save(broken)).ok).toBe(false);

    const orphans = await database.pool.query(
      `SELECT 1 FROM scoring.score_record WHERE score_record_id = $1`,
      [record.scoreRecordId],
    );
    expect(orphans.rowCount).toBe(0);
  });
});

describe('generations', () => {
  it('rejects a second current record for one attempt', async () => {
    const attemptId = randomUUID();
    expectValue(await repository.save(build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]])));

    const second = build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]);
    const conflict = expectError(await repository.save(second));
    expect(conflict.kind).toBe('Conflict');
  });

  it('supersedes in one transaction, retaining both generations', async () => {
    const attemptId = randomUUID();
    const first = build(attemptId, randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(first));

    const second: ScoreRecord = {
      ...build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]),
      generation: 2,
      supersedesScoreRecordId: first.scoreRecordId,
      reasonForRescore: 'answer key challenge upheld',
    };
    expectValue(await repository.supersede(first.scoreRecordId, second));

    const generations = expectValue(await repository.findAllGenerationsByAttemptId(attemptId));
    expect(generations.map((record) => record.generation)).toEqual([1, 2]);
    expect(generations.map((record) => record.isCurrent)).toEqual([false, true]);
  });

  it('leaves the superseded record byte-identical apart from isCurrent', async () => {
    const attemptId = randomUUID();
    const first = build(attemptId, randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(first));

    const second: ScoreRecord = {
      ...build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]),
      generation: 2,
      supersedesScoreRecordId: first.scoreRecordId,
      reasonForRescore: 'answer key challenge upheld',
    };
    expectValue(await repository.supersede(first.scoreRecordId, second));

    const reloaded = expectValue(await repository.findById(first.scoreRecordId));
    expect(reloaded).toEqual(markSuperseded(first));
  });

  it('finds the current record and not the superseded one', async () => {
    const attemptId = randomUUID();
    const first = build(attemptId, randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(first));

    const second: ScoreRecord = {
      ...build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]),
      generation: 2,
      supersedesScoreRecordId: first.scoreRecordId,
      reasonForRescore: 'r',
    };
    expectValue(await repository.supersede(first.scoreRecordId, second));

    const current = expectValue(await repository.findCurrentByAttemptId(attemptId));
    expect(current.scoreRecordId).toBe(second.scoreRecordId);
    expect(current.generation).toBe(2);
  });

  it('returns generations oldest first', async () => {
    const attemptId = randomUUID();
    const first = build(attemptId, randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(first));
    const second: ScoreRecord = {
      ...build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]),
      generation: 2,
      supersedesScoreRecordId: first.scoreRecordId,
      reasonForRescore: 'r',
    };
    expectValue(await repository.supersede(first.scoreRecordId, second));

    const generations = expectValue(await repository.findAllGenerationsByAttemptId(attemptId));
    expect(generations).toHaveLength(2);
    expect(generations[0]?.generation).toBeLessThan(generations[1]?.generation ?? 0);
  });

  it('returns an empty list for an attempt with no score', async () => {
    expect(expectValue(await repository.findAllGenerationsByAttemptId(randomUUID()))).toEqual([]);
  });

  it('reports no current record for an attempt that has none', async () => {
    expect(expectError(await repository.findCurrentByAttemptId(randomUUID())).kind).toBe('NotFound');
  });
});

describe('a corrupt stored mark is a fault, not a score of nothing', () => {
  it('throws rather than reading NaN as zero', async () => {
    const attemptId = randomUUID();
    const record = build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]);
    expectValue(await repository.save(record));

    // `numeric` accepts NaN, so a row this repository did not write can hold
    // one. Reading it as zero would present a corrupt row as a real result.
    await database.pool.query(
      `UPDATE scoring.section_score SET raw = 'NaN' WHERE score_record_id = $1`,
      [record.scoreRecordId],
    ).catch(async () => {
      // section_score is append-only, so go in through a fresh record instead.
      await database.pool.query(
        `INSERT INTO scoring.section_score
           (score_record_id, section_ordinal, raw, max_available, attempted_count,
            correct_count, incorrect_count, negative_marks)
         VALUES ($1, 2, 'NaN', 4, 1, 1, 0, 0)`,
        [record.scoreRecordId],
      );
    });

    await expect(repository.findById(record.scoreRecordId)).rejects.toThrow('is not a number');
  });
});

describe('a rejected write is reported, never swallowed', () => {
  it('surfaces a constraint violation that is not a conflict', async () => {
    // numeric(14,4) leaves ten integer digits. An eleven-digit mark overflows
    // the column, which is the database refusing the write rather than a race.
    const record = build(randomUUID(), randomUUID(), [[slot('a', 1, chose('B'), 99_999_999_999)]]);
    const error = expectError(await repository.save(record));
    expect(error.code).toBe('PERSISTENCE_REJECTED');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe('a re-score records the operation that caused it', () => {
  it('stores the rescoring operation id against the successor', async () => {
    const attemptId = randomUUID();
    const first = build(attemptId, randomUUID(), [[slot('a', 1, chose('A'))]]);
    expectValue(await repository.save(first));

    const operationId = randomUUID();
    await database.pool.query(
      `INSERT INTO scoring.rescoring_operation
         (rescoring_operation_id, trigger, scope, scope_ref, reason, state)
       VALUES ($1, 'CHALLENGE_UPHELD', 'ITEM_VERSION', 'iv-1', 'upheld', 'drafted')`,
      [operationId],
    );

    const second: ScoreRecord = {
      ...build(attemptId, randomUUID(), [[slot('a', 1, chose('B'))]]),
      generation: 2,
      supersedesScoreRecordId: first.scoreRecordId,
      reasonForRescore: 'answer key challenge upheld',
    };
    expectValue(await repository.supersede(first.scoreRecordId, second, operationId));

    const stored = await database.pool.query<{ rescoring_operation_id: string | null }>(
      `SELECT rescoring_operation_id FROM scoring.score_record WHERE score_record_id = $1`,
      [second.scoreRecordId],
    );
    expect(stored.rows[0]?.rescoring_operation_id).toBe(operationId);
  });
});
