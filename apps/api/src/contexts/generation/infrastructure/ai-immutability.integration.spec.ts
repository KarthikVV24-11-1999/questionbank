import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkNoWriteGrantOnAppendOnlyTable, type GrantRow } from '../../../fitness/content-rules.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { MODEL_VERSION, PROMPT_VERSION, ensureVersions } from '../../../testing/generation-fixtures.js';

/**
 * §9 rule 11 for the `ai` schema, proven by issuing the mutation and reading
 * the refusal — never by asserting the grant text (ENGINEERING-HANDBOOK §5).
 *
 * Two different refusals are proven separately, because they are two controls:
 *   - as the owner, the row trigger refuses UPDATE and DELETE;
 *   - as the application role, the missing privilege refuses UPDATE, DELETE
 *     and TRUNCATE before a trigger is ever reached.
 */
let database: TestDatabase;

const APP_ROLE = 'questionbank_app';
const AI_TABLES = [
  'candidate_decision',
  'candidate_verdict',
  'generation_candidate',
  'generation_run',
  'model_version',
  'prompt_version',
];

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

async function rows<T>(query: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await database.pool.query(query, [...params]);
  return result.rows as T[];
}

async function rejects(query: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(query, [...params]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected the database to refuse: ${query}`);
}

/** Runs `work` on one connection that has assumed the application role, then gives the role back. */
async function asAppRole<T>(work: (query: (text: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query(`SET ROLE ${APP_ROLE}`);
    return await work(async (text, params = []) => (await client.query(text, [...params])).rows);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

async function appRoleRejects(query: string, params: readonly unknown[] = []): Promise<string> {
  return asAppRole(async (run) => {
    try {
      await run(query, params);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`expected the database to refuse the application role: ${query}`);
  });
}

interface Seeded {
  readonly runId: string;
  readonly candidateId: string;
}

async function seed(): Promise<Seeded> {
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  const [run] = await rows<{ run_id: string }>(
    `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
     VALUES ('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', '2026-10-16T09:30:00Z', '{"count": 5}') RETURNING run_id`,
  );
  const [candidate] = await rows<{ candidate_id: string }>(
    `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
     VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'SINGLE_CORRECT_MCQ', '{"stem": "x"}', 0.5) RETURNING candidate_id`,
    [run!.run_id],
  );
  await database.pool.query(
    `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, detail, ordinal)
     VALUES ($1, 'answer_verification', 'fail', 'solves disagree', 0)`,
    [candidate!.candidate_id],
  );
  await database.pool.query(`INSERT INTO ai.candidate_decision (candidate_id, decision) VALUES ($1, 'rejected')`, [
    candidate!.candidate_id,
  ]);
  return { runId: run!.run_id, candidateId: candidate!.candidate_id };
}

describe('the row triggers refuse a rewrite, from every role including the owner', () => {
  const MUTATIONS: readonly (readonly [string, string, string])[] = [
    ['generation_run', 'UPDATE ai.generation_run SET model_version_id = \'00000000-0000-4000-8000-0000000a0009\'', 'DELETE FROM ai.generation_run'],
    ['generation_candidate', 'UPDATE ai.generation_candidate SET item_type = \'OTHER\'', 'DELETE FROM ai.generation_candidate'],
    ['candidate_verdict', 'UPDATE ai.candidate_verdict SET outcome = \'pass\'', 'DELETE FROM ai.candidate_verdict'],
    ['candidate_decision', 'UPDATE ai.candidate_decision SET decision = \'accepted\'', 'DELETE FROM ai.candidate_decision'],
    ['model_version', 'UPDATE ai.model_version SET provider_model_id = \'some-other-model\'', 'DELETE FROM ai.model_version'],
    ['prompt_version', 'UPDATE ai.prompt_version SET source_file = \'prompts/other.md\'', 'DELETE FROM ai.prompt_version'],
  ];

  it('covers every table the schema holds', async () => {
    const tables = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai' ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(AI_TABLES);
    expect(MUTATIONS.map(([table]) => table).sort()).toEqual(AI_TABLES);
  });

  for (const [table, update, remove] of MUTATIONS) {
    it(`refuses UPDATE and DELETE on ai.${table}`, async () => {
      await seed();
      expect(await rejects(update)).toContain('append-only');
      expect(await rejects(remove)).toContain('append-only');
    });
  }

  // The audit property itself: the sentence the pre-check battery rests on.
  it('cannot rewrite a recorded verdict — a fail stays a fail, with its detail', async () => {
    const { candidateId } = await seed();

    await rejects(`UPDATE ai.candidate_verdict SET outcome = 'pass' WHERE candidate_id = $1`, [candidateId]);
    await rejects(`UPDATE ai.candidate_verdict SET detail = 'solves agree' WHERE candidate_id = $1`, [candidateId]);
    await rejects(`DELETE FROM ai.candidate_verdict WHERE candidate_id = $1`, [candidateId]);

    const [stored] = await rows<{ outcome: string; detail: string }>(
      `SELECT outcome, detail FROM ai.candidate_verdict WHERE candidate_id = $1 AND check_id = 'answer_verification'`,
      [candidateId],
    );
    expect(stored).toEqual({ outcome: 'fail', detail: 'solves disagree' });
  });

  it('cannot rewrite the pin or the proposal a candidate was recorded with', async () => {
    const { candidateId } = await seed();
    expect(await rejects(`UPDATE ai.generation_candidate SET prompt_version_id = '00000000-0000-4000-8000-0000000b0008' WHERE candidate_id = $1`, [candidateId]))
      .toContain('append-only');
    expect(await rejects(`UPDATE ai.generation_candidate SET body = '{}' WHERE candidate_id = $1`, [candidateId]))
      .toContain('append-only');
  });

  it('cannot reverse a decision once it is recorded', async () => {
    const { candidateId } = await seed();
    expect(await rejects(`UPDATE ai.candidate_decision SET decision = 'accepted' WHERE candidate_id = $1`, [candidateId]))
      .toContain('append-only');
    expect(await rejects(`DELETE FROM ai.candidate_decision WHERE candidate_id = $1`, [candidateId])).toContain('append-only');
  });
});

describe('the application role holds no privilege to try', () => {
  // Any column will do; the privilege is checked before the statement is.
  const KEY_COLUMN: Readonly<Record<string, string>> = {
    candidate_decision: 'candidate_id',
    candidate_verdict: 'candidate_id',
    generation_candidate: 'candidate_id',
    generation_run: 'run_id',
    model_version: 'model_version_id',
    prompt_version: 'prompt_version_id',
  };

  for (const table of AI_TABLES) {
    it(`is refused UPDATE, DELETE and TRUNCATE on ai.${table} by the privilege check itself`, async () => {
      await seed();
      const column = KEY_COLUMN[table]!;
      expect(await appRoleRejects(`UPDATE ai.${table} SET ${column} = ${column}`)).toContain('permission denied');
      expect(await appRoleRejects(`DELETE FROM ai.${table}`)).toContain('permission denied');
      expect(await appRoleRejects(`TRUNCATE ai.${table}`)).toContain('permission denied');
    });
  }

  it('can still read and append — the repositories’ whole job', async () => {
    await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
    const run = await asAppRole(async (query) => {
      const inserted = (await query(
        `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
         VALUES ('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', now(), '{}') RETURNING run_id`,
      )) as { run_id: string }[];
      const read = await query(`SELECT run_id FROM ai.generation_run WHERE run_id = $1`, [inserted[0]!.run_id]);
      return { inserted: inserted.length, read: read.length };
    });
    expect(run).toEqual({ inserted: 1, read: 1 });
  });

  it('reports the privilege set from the catalogue: SELECT and INSERT, and nothing else', async () => {
    const privileges = await rows<{ table_name: string; privilege: string; held: boolean }>(
      `SELECT t.table_name, p.privilege, has_table_privilege($1, format('ai.%I', t.table_name), p.privilege) AS held
         FROM information_schema.tables t
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege)
        WHERE t.table_schema = 'ai'
        ORDER BY t.table_name, p.privilege`,
      [APP_ROLE],
    );
    const held = privileges.filter((row) => row.held).map((row) => `${row.table_name}:${row.privilege}`);
    expect(held).toEqual(AI_TABLES.flatMap((table) => [`${table}:INSERT`, `${table}:SELECT`]));
  });

  it('holds USAGE on the schema, so the grants above are reachable at all', async () => {
    const [usage] = await rows<{ usage: boolean }>(`SELECT has_schema_privilege($1, 'ai', 'USAGE') AS usage`, [APP_ROLE]);
    expect(usage?.usage).toBe(true);
  });

  // A table added to `ai` later is append-only for the application role until
  // someone decides otherwise — the default, not a thing to remember.
  it('is granted only SELECT and INSERT on a table created afterwards', async () => {
    await database.pool.query(`CREATE TABLE ai.later_table (id integer)`);
    try {
      const [grants] = await rows<{ select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>(
        `SELECT has_table_privilege($1, 'ai.later_table', 'SELECT') AS "select",
                has_table_privilege($1, 'ai.later_table', 'INSERT') AS "insert",
                has_table_privilege($1, 'ai.later_table', 'UPDATE') AS "update",
                has_table_privilege($1, 'ai.later_table', 'DELETE') AS "delete",
                has_table_privilege($1, 'ai.later_table', 'TRUNCATE') AS "truncate"`,
        [APP_ROLE],
      );
      expect(grants).toEqual({ select: true, insert: true, update: false, delete: false, truncate: false });
    } finally {
      await database.pool.query(`DROP TABLE ai.later_table`);
    }
  });
});

describe('F40 — the shared judgement, over the ai catalogue', () => {
  async function grantRows(): Promise<GrantRow[]> {
    return rows<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants WHERE table_schema = 'ai'`,
    );
  }

  it('finds no UPDATE, DELETE or TRUNCATE held by the application role, over a catalogue that is not empty', async () => {
    const grants = await grantRows();
    expect(new Set(grants.filter((grant) => grant.grantee === APP_ROLE).map((grant) => grant.table))).toEqual(
      new Set(AI_TABLES),
    );
    expect(checkNoWriteGrantOnAppendOnlyTable(grants, [APP_ROLE])).toEqual([]);
  });

  // A grant planted for real, inside a transaction that is rolled back: the
  // judgement is shown to fire on the catalogue's own shape.
  it('fires when UPDATE is actually granted on an ai table', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`GRANT UPDATE ON ai.candidate_verdict TO ${APP_ROLE}`);
      const { rows: planted } = await client.query<GrantRow>(
        `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
           FROM information_schema.role_table_grants WHERE table_schema = 'ai'`,
      );
      expect(checkNoWriteGrantOnAppendOnlyTable(planted, [APP_ROLE])).toEqual([
        { rule: 'F40_WRITE_GRANT_ON_AN_APPEND_ONLY_TABLE', subject: 'candidate_verdict', detail: `${APP_ROLE} holds UPDATE` },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
