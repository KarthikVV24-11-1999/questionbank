import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';

/**
 * Proven with raw SQL, not through the ORM. An immutability rule the ORM
 * happens to respect is a convention; one the database enforces is an
 * invariant, and only the second survives a migration script, a psql session,
 * or a future repository nobody has written yet.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

/** Runs raw SQL expected to fail, and returns the PostgreSQL error message. */
async function rejectionMessage(text: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(text, [...params]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(the statement succeeded)';
}

let attemptCounter = 0;

async function insertRecord(generation = 1, supersedes: string | null = null): Promise<string> {
  attemptCounter += 1;
  const attemptId = `aaaaaaaa-0000-0000-0000-${String(attemptCounter).padStart(12, '0')}`;
  const inserted = await database.pool.query<{ score_record_id: string }>(
    `INSERT INTO scoring.score_record
       (attempt_id, exam_profile_version_id, marking_rule_set_hash, rule_schema_version,
        taxonomy_version_id, generation, supersedes_score_record_id, reason_for_rescore,
        total_raw, total_max_available, total_attempted_count, total_correct_count,
        total_incorrect_count, total_negative_marks, computed_at)
     VALUES ($1, gen_random_uuid(), 'hash', 1, gen_random_uuid(), $2, $3, $4, 7, 12, 3, 2, 1, 1, now())
     RETURNING score_record_id`,
    [attemptId, generation, supersedes, generation > 1 ? 'challenge upheld' : null],
  );
  return (inserted.rows[0] as { score_record_id: string }).score_record_id;
}

async function insertOutcome(scoreRecordId: string): Promise<string> {
  const inserted = await database.pool.query<{ item_outcome_id: string }>(
    `INSERT INTO scoring.item_outcome
       (score_record_id, slot_id, slot_ordinal, section_ordinal, item_version_id,
        correctness, marks_awarded, marks_available, rule_applied_id, rule_applied_explanation)
     VALUES ($1, 'slot-1', 1, 1, gen_random_uuid(), 'correct', 4, 4, 'correct', 'correct → +4 marks')
     RETURNING item_outcome_id`,
    [scoreRecordId],
  );
  return (inserted.rows[0] as { item_outcome_id: string }).item_outcome_id;
}

async function insertSection(scoreRecordId: string): Promise<void> {
  await database.pool.query(
    `INSERT INTO scoring.section_score
       (score_record_id, section_ordinal, raw, max_available, attempted_count,
        correct_count, incorrect_count, negative_marks)
     VALUES ($1, 1, 7, 12, 3, 2, 1, 1)`,
    [scoreRecordId],
  );
}

describe('a score record rejects mutation under raw SQL', () => {
  it('rejects an update to the total', async () => {
    const id = await insertRecord();
    const message = await rejectionMessage(
      `UPDATE scoring.score_record SET total_raw = 300 WHERE score_record_id = $1`,
      [id],
    );
    expect(message).toContain('score_record_is_append_only');
  });

  it('rejects an update to the pinned rule set hash', async () => {
    const id = await insertRecord();
    const message = await rejectionMessage(
      `UPDATE scoring.score_record SET marking_rule_set_hash = 'tampered' WHERE score_record_id = $1`,
      [id],
    );
    expect(message).toContain('score_record_is_append_only');
  });

  it('rejects a delete', async () => {
    const id = await insertRecord();
    const message = await rejectionMessage(`DELETE FROM scoring.score_record WHERE score_record_id = $1`, [id]);
    expect(message).toContain('never deleted');
  });

  it('rejects a bulk delete of every record', async () => {
    await insertRecord();
    expect(await rejectionMessage(`DELETE FROM scoring.score_record`)).toContain('never deleted');
  });

  it('rejects an update that changes is_current alongside something else', async () => {
    const id = await insertRecord();
    const message = await rejectionMessage(
      `UPDATE scoring.score_record SET is_current = false, total_raw = 300 WHERE score_record_id = $1`,
      [id],
    );
    expect(message).toContain('only is_current may change');
  });
});

describe('standing a record down is the one permitted update', () => {
  it('permits the flip from current to superseded', async () => {
    const id = await insertRecord();
    await expect(
      database.pool.query(`UPDATE scoring.score_record SET is_current = false WHERE score_record_id = $1`, [id]),
    ).resolves.toBeDefined();
  });

  it('refuses to make a superseded record current again', async () => {
    const id = await insertRecord();
    await database.pool.query(`UPDATE scoring.score_record SET is_current = false WHERE score_record_id = $1`, [
      id,
    ]);
    const message = await rejectionMessage(
      `UPDATE scoring.score_record SET is_current = true WHERE score_record_id = $1`,
      [id],
    );
    expect(message).toContain('only from true to false');
  });

  it('retains both generations after a re-score', async () => {
    const first = await insertRecord();
    const attempt = await database.pool.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM scoring.score_record WHERE score_record_id = $1`,
      [first],
    );
    const attemptId = (attempt.rows[0] as { attempt_id: string }).attempt_id;

    await database.pool.query(`UPDATE scoring.score_record SET is_current = false WHERE score_record_id = $1`, [
      first,
    ]);
    await database.pool.query(
      `INSERT INTO scoring.score_record
         (attempt_id, exam_profile_version_id, marking_rule_set_hash, rule_schema_version,
          taxonomy_version_id, generation, supersedes_score_record_id, reason_for_rescore,
          total_raw, total_max_available, total_attempted_count, total_correct_count,
          total_incorrect_count, total_negative_marks, computed_at)
       VALUES ($1, gen_random_uuid(), 'hash', 1, gen_random_uuid(), 2, $2, 'challenge upheld',
               11, 12, 3, 3, 0, 0, now())`,
      [attemptId, first],
    );

    const generations = await database.pool.query<{ generation: number; is_current: boolean }>(
      `SELECT generation, is_current FROM scoring.score_record WHERE attempt_id = $1 ORDER BY generation`,
      [attemptId],
    );
    expect(generations.rows).toEqual([
      { generation: 1, is_current: false },
      { generation: 2, is_current: true },
    ]);
  });
});

describe('item outcomes and section scores admit no update at all', () => {
  it('rejects an update to an item outcome', async () => {
    const record = await insertRecord();
    const outcome = await insertOutcome(record);
    const message = await rejectionMessage(
      `UPDATE scoring.item_outcome SET marks_awarded = 99 WHERE item_outcome_id = $1`,
      [outcome],
    );
    expect(message).toContain('score_detail_is_append_only');
    expect(message).toContain('item_outcome');
  });

  it('rejects an update to the rule attribution', async () => {
    const record = await insertRecord();
    const outcome = await insertOutcome(record);
    const message = await rejectionMessage(
      `UPDATE scoring.item_outcome SET rule_applied_id = 'something-else' WHERE item_outcome_id = $1`,
      [outcome],
    );
    expect(message).toContain('append-only');
  });

  it('rejects a delete of an item outcome', async () => {
    const record = await insertRecord();
    const outcome = await insertOutcome(record);
    const message = await rejectionMessage(`DELETE FROM scoring.item_outcome WHERE item_outcome_id = $1`, [
      outcome,
    ]);
    expect(message).toContain('append-only');
  });

  it('rejects an update to a section score', async () => {
    const record = await insertRecord();
    await insertSection(record);
    const message = await rejectionMessage(
      `UPDATE scoring.section_score SET raw = 99 WHERE score_record_id = $1`,
      [record],
    );
    expect(message).toContain('score_detail_is_append_only');
  });

  it('rejects a delete of a section score', async () => {
    const record = await insertRecord();
    await insertSection(record);
    const message = await rejectionMessage(`DELETE FROM scoring.section_score WHERE score_record_id = $1`, [
      record,
    ]);
    expect(message).toContain('append-only');
  });
});

describe('the detail tables cannot be emptied through their parent', () => {
  it('cannot be cascaded away, because the parent cannot be deleted', async () => {
    const record = await insertRecord();
    await insertOutcome(record);
    expect(await rejectionMessage(`DELETE FROM scoring.score_record WHERE score_record_id = $1`, [record])).toContain(
      'never deleted',
    );

    const surviving = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scoring.item_outcome WHERE score_record_id = $1`,
      [record],
    );
    expect((surviving.rows[0] as { count: string }).count).toBe('1');
  });
});

describe('the triggers are in place', () => {
  it('declares one on each append-only table', async () => {
    const triggers = await database.pool.query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'scoring' AND NOT t.tgisinternal
        ORDER BY c.relname`,
    );
    expect(triggers.rows.map((row) => row.relname)).toEqual(['item_outcome', 'score_record', 'section_score']);
  });
});
