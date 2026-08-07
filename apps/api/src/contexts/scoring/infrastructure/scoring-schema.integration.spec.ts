import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';

/**
 * Real Postgres, never a mock (ENGINEERING-HANDBOOK §5). These specs create and
 * drop the `scoring` schema, so they run against a throwaway database.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

async function rows<T>(query: string): Promise<T[]> {
  const result = await database.pool.query(query);
  return result.rows as T[];
}

const SCORING_TABLES = ['item_outcome', 'rescoring_operation', 'score_record', 'section_score'];

describe('the scoring schema', () => {
  it('creates exactly the four tables the domain model names', async () => {
    const found = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'scoring' ORDER BY table_name`,
    );
    expect(found.map((row) => row.table_name)).toEqual(SCORING_TABLES);
  });

  it('names every table in the singular (§2)', () => {
    for (const table of SCORING_TABLES) {
      expect(table.endsWith('s'), table).toBe(false);
    }
  });

  it('carries tenant_id, aggregate_version and created_at on each aggregate root', async () => {
    for (const table of ['score_record', 'rescoring_operation']) {
      const columns = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'scoring' AND table_name = '${table}'`,
      );
      const names = columns.map((row) => row.column_name);
      expect(names, table).toContain('tenant_id');
      expect(names, table).toContain('aggregate_version');
      expect(names, table).toContain('created_at');
    }
  });
});

describe('F5 — every JSONB column has a sibling *_schema_version', () => {
  it('holds across the whole scoring schema', async () => {
    const orphans = await rows<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'scoring'
          AND c.data_type = 'jsonb'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns s
             WHERE s.table_schema = c.table_schema
               AND s.table_name = c.table_name
               AND s.column_name = c.column_name || '_schema_version')`,
    );
    expect(orphans).toEqual([]);
  });

  it('holds for the aggregation column added to curriculum (ADR-0006)', async () => {
    const orphans = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'curriculum' AND table_name = 'exam_profile_version'
          AND data_type = 'jsonb'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns s
             WHERE s.table_schema = 'curriculum' AND s.table_name = 'exam_profile_version'
               AND s.column_name = information_schema.columns.column_name || '_schema_version')`,
    );
    expect(orphans).toEqual([]);
  });
});

describe('§9 rule 3 — no foreign key crosses a schema boundary', () => {
  it('holds for every constraint the scoring schema declares', async () => {
    const crossing = await rows<{ constraint_name: string; foreign_schema: string }>(
      `SELECT con.conname AS constraint_name, nsp_f.nspname AS foreign_schema
         FROM pg_constraint con
         JOIN pg_class rel      ON rel.oid = con.conrelid
         JOIN pg_namespace nsp  ON nsp.oid = rel.relnamespace
         JOIN pg_class relf     ON relf.oid = con.confrelid
         JOIN pg_namespace nsp_f ON nsp_f.oid = relf.relnamespace
        WHERE con.contype = 'f' AND nsp.nspname = 'scoring' AND nsp_f.nspname <> 'scoring'`,
    );
    expect(crossing).toEqual([]);
  });

  it('carries the profile version and rule set hash as values, not references', async () => {
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'scoring' AND table_name = 'score_record'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('exam_profile_version_id');
    expect(names).toContain('marking_rule_set_hash');
  });
});

describe('F47 — the database refuses an unexplainable outcome', () => {
  it('rejects an item outcome with no rule_applied_id', async () => {
    await expect(
      database.pool.query(
        `INSERT INTO scoring.item_outcome
           (score_record_id, slot_id, slot_ordinal, section_ordinal, item_version_id,
            correctness, marks_awarded, marks_available, rule_applied_id, rule_applied_explanation)
         VALUES (gen_random_uuid(), 'a', 1, 1, gen_random_uuid(), 'correct', 4, 4, NULL, 'e')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a blank rule_applied_id', async () => {
    await expect(
      database.pool.query(
        `INSERT INTO scoring.item_outcome
           (score_record_id, slot_id, slot_ordinal, section_ordinal, item_version_id,
            correctness, marks_awarded, marks_available, rule_applied_id, rule_applied_explanation)
         VALUES (gen_random_uuid(), 'a', 1, 1, gen_random_uuid(), 'correct', 4, 4, '   ', 'e')`,
      ),
    ).rejects.toThrow();
  });
});

describe('INV-11 — exactly one current score record per attempt', () => {
  const insert = (attemptId: string, generation: number, isCurrent: boolean, supersedes?: string) =>
    database.pool.query(
      `INSERT INTO scoring.score_record
         (attempt_id, exam_profile_version_id, marking_rule_set_hash, rule_schema_version,
          taxonomy_version_id, generation, is_current, supersedes_score_record_id, reason_for_rescore,
          total_raw, total_max_available, total_attempted_count, total_correct_count,
          total_incorrect_count, total_negative_marks, computed_at)
       VALUES ($1, gen_random_uuid(), 'hash', 1, gen_random_uuid(), $2, $3, $4, $5,
               4, 4, 1, 1, 0, 0, now())
       RETURNING score_record_id`,
      [attemptId, generation, isCurrent, supersedes ?? null, generation > 1 ? 'challenge upheld' : null],
    );

  it('accepts the first current record', async () => {
    const attempt = '11111111-1111-1111-1111-111111111111';
    const inserted = await insert(attempt, 1, true);
    expect(inserted.rows).toHaveLength(1);
  });

  it('rejects a second current record for the same attempt', async () => {
    const attempt = '22222222-2222-2222-2222-222222222222';
    await insert(attempt, 1, true);
    await expect(insert(attempt, 2, true, (await firstRecordId(attempt)) ?? undefined)).rejects.toThrow();
  });

  it('retains both generations once the first is stood down', async () => {
    const attempt = '33333333-3333-3333-3333-333333333333';
    const first = await insert(attempt, 1, true);
    const firstId = (first.rows[0] as { score_record_id: string }).score_record_id;

    await database.pool.query(`UPDATE scoring.score_record SET is_current = false WHERE score_record_id = $1`, [
      firstId,
    ]);
    await insert(attempt, 2, true, firstId);

    const generations = await rows<{ generation: number; is_current: boolean }>(
      `SELECT generation, is_current FROM scoring.score_record
        WHERE attempt_id = '${attempt}' ORDER BY generation`,
    );
    expect(generations).toEqual([
      { generation: 1, is_current: false },
      { generation: 2, is_current: true },
    ]);
  });

  async function firstRecordId(attemptId: string): Promise<string | null> {
    const found = await rows<{ score_record_id: string }>(
      `SELECT score_record_id FROM scoring.score_record WHERE attempt_id = '${attemptId}' LIMIT 1`,
    );
    return found[0]?.score_record_id ?? null;
  }
});

describe('generation constraints at the database', () => {
  const insert = (attemptId: string, generation: number, supersedes: string | null, reason: string | null) =>
    database.pool.query(
      `INSERT INTO scoring.score_record
         (attempt_id, exam_profile_version_id, marking_rule_set_hash, rule_schema_version,
          taxonomy_version_id, generation, supersedes_score_record_id, reason_for_rescore,
          total_raw, total_max_available, total_attempted_count, total_correct_count,
          total_incorrect_count, total_negative_marks, computed_at)
       VALUES ($1, gen_random_uuid(), 'hash', 1, gen_random_uuid(), $2, $3, $4, 4, 4, 1, 1, 0, 0, now())`,
      [attemptId, generation, supersedes, reason],
    );

  it('rejects a first generation that claims a predecessor', async () => {
    await expect(
      insert('44444444-4444-4444-4444-444444444444', 1, '00000000-0000-0000-0000-000000000001', null),
    ).rejects.toThrow();
  });

  it('rejects a re-score with no reason', async () => {
    const attempt = '55555555-5555-5555-5555-555555555555';
    await insert(attempt, 1, null, null);
    const first = await rows<{ score_record_id: string }>(
      `SELECT score_record_id FROM scoring.score_record WHERE attempt_id = '${attempt}'`,
    );
    await database.pool.query(`UPDATE scoring.score_record SET is_current = false WHERE attempt_id = $1`, [
      attempt,
    ]);
    await expect(insert(attempt, 2, first[0]?.score_record_id ?? null, '  ')).rejects.toThrow();
  });
});

describe('the rescoring operation refuses an ungated approval', () => {
  const insert = (state: string, withPreview: boolean, withPrincipal: boolean) =>
    database.pool.query(
      `INSERT INTO scoring.rescoring_operation
         (trigger, scope, scope_ref, reason, state, dry_run_result, authorized_by_kind, authorized_by_id, executed_at)
       VALUES ('CHALLENGE_UPHELD', 'ITEM_VERSION', 'iv-1', 'upheld', $1, $2, $3, $4, $5)`,
      [
        state,
        withPreview ? '{"affectedAttemptCount":0}' : null,
        withPrincipal ? 'human' : null,
        withPrincipal ? '00000000-0000-0000-0000-000000000009' : null,
        state === 'completed' ? new Date().toISOString() : null,
      ],
    );

  it('accepts a draft with no preview', async () => {
    await expect(insert('drafted', false, false)).resolves.toBeDefined();
  });

  it('rejects an approval with no dry run', async () => {
    await expect(insert('approved', false, true)).rejects.toThrow();
  });

  it('rejects an approval with no principal', async () => {
    await expect(insert('approved', true, false)).rejects.toThrow();
  });

  it('accepts an approval that has both', async () => {
    await expect(insert('approved', true, true)).resolves.toBeDefined();
  });

  it('requires an execution timestamp exactly when completed', async () => {
    await expect(insert('completed', true, true)).resolves.toBeDefined();
    await expect(
      database.pool.query(
        `INSERT INTO scoring.rescoring_operation
           (trigger, scope, scope_ref, reason, state, dry_run_result, authorized_by_kind, authorized_by_id)
         VALUES ('CHALLENGE_UPHELD', 'ITEM_VERSION', 'iv-1', 'upheld', 'completed', '{}', 'human',
                 '00000000-0000-0000-0000-000000000009')`,
      ),
    ).rejects.toThrow();
  });
});

describe('migrations run up, down and up again on a clean database', () => {
  it('leaves no scoring schema behind on down, and rebuilds it on up', async () => {
    await database.revertMigrations();
    const gone = await rows<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname IN ('scoring', 'curriculum')`,
    );
    expect(gone).toEqual([]);

    await database.applyMigrations();
    const rebuilt = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'scoring' ORDER BY table_name`,
    );
    expect(rebuilt.map((row) => row.table_name)).toEqual(SCORING_TABLES);
  });
});
