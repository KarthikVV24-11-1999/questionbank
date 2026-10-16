import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { ensureVersions } from '../../../testing/generation-fixtures.js';
import { CANDIDATE_STATES } from '../domain/generation-candidate.js';
import { PRECHECK_IDS } from '../domain/precheck-vocabulary.js';

/**
 * Real Postgres, never a mock (ENGINEERING-HANDBOOK §5). The shape of the `ai`
 * schema, asserted against the catalogue rather than against the migration's
 * text. These specs create and drop the schema, so they run against a
 * throwaway database.
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

const AI_TABLES = [
  'candidate_decision',
  'candidate_verdict',
  'generation_candidate',
  'generation_run',
  'model_version',
  'prompt_version',
];

async function newRun(model = '00000000-0000-4000-8000-0000000a0003', prompt = '00000000-0000-4000-8000-0000000b0007'): Promise<string> {
  await ensureVersions(database.pool, { modelVersionId: model, promptVersionId: prompt });
  const [run] = await rows<{ run_id: string }>(
    `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
     VALUES ($1, $2, '2026-10-16T09:30:00Z', '{"count": 5}') RETURNING run_id`,
    [model, prompt],
  );
  return run!.run_id;
}

async function newCandidate(runId: string, model = '00000000-0000-4000-8000-0000000a0003', prompt = '00000000-0000-4000-8000-0000000b0007'): Promise<string> {
  const [candidate] = await rows<{ candidate_id: string }>(
    `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
     VALUES ($1, $2, $3, 'SINGLE_CORRECT_MCQ', '{"stem": "x"}', 0.5) RETURNING candidate_id`,
    [runId, model, prompt],
  );
  return candidate!.candidate_id;
}

describe('the ai schema is its own', () => {
  it('exists as a schema, holding exactly the generation tables', async () => {
    const tables = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai' ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(AI_TABLES);
  });

  it('puts none of those tables in public or content', async () => {
    const strays = await rows<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name = ANY($1) AND table_schema <> 'ai'`,
      [AI_TABLES],
    );
    expect(strays).toEqual([]);
  });

  // §9 rule 3. Asserted over the constraint catalogue in both directions, so a
  // key leaving `ai` and a key arriving at it are both caught.
  it('has no foreign key crossing the schema boundary, and does have the ones inside it', async () => {
    const keys = await rows<{ from_schema: string; from_table: string; to_schema: string; to_table: string }>(
      `SELECT child_ns.nspname AS from_schema, child.relname AS from_table,
              parent_ns.nspname AS to_schema, parent.relname AS to_table
         FROM pg_constraint c
         JOIN pg_class child ON child.oid = c.conrelid
         JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
         JOIN pg_class parent ON parent.oid = c.confrelid
         JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE c.contype = 'f' AND (child_ns.nspname = 'ai' OR parent_ns.nspname = 'ai')
        ORDER BY child.relname, parent.relname`,
    );

    expect(keys.filter((key) => key.from_schema !== 'ai' || key.to_schema !== 'ai')).toEqual([]);
    expect(keys.map((key) => `${key.from_table}->${key.to_table}`)).toEqual([
      'candidate_decision->generation_candidate',
      'candidate_verdict->generation_candidate',
      'generation_candidate->generation_run',
      'generation_run->model_version',
      'generation_run->prompt_version',
    ]);
  });
});

describe('F28 — the pin is stored, and cannot be absent', () => {
  it('declares the model version, prompt version and run id NOT NULL on both tables that carry them', async () => {
    const columns = await rows<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name IN ('generation_run', 'generation_candidate')
          AND column_name IN ('model_version_id', 'prompt_version_id', 'run_id')
        ORDER BY table_name, column_name`,
    );
    expect(columns.map((column) => `${column.table_name}.${column.column_name}:${column.is_nullable}`)).toEqual([
      'generation_candidate.model_version_id:NO',
      'generation_candidate.prompt_version_id:NO',
      'generation_candidate.run_id:NO',
      'generation_run.model_version_id:NO',
      'generation_run.prompt_version_id:NO',
      'generation_run.run_id:NO',
    ]);
  });

  it('refuses a candidate with any member of the pin missing', async () => {
    const run = await newRun();
    for (const column of ['run_id', 'model_version_id', 'prompt_version_id']) {
      const values = { run_id: run, model_version_id: '00000000-0000-4000-8000-0000000a0003', prompt_version_id: '00000000-0000-4000-8000-0000000b0007' } as Record<string, string | null>;
      values[column] = null;
      const message = await rejects(
        `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
         VALUES ($1, $2, $3, 'X', '{}', 0.5)`,
        [values['run_id'], values['model_version_id'], values['prompt_version_id']],
      );
      expect(message, column).toContain('null value');
      expect(message, column).toContain(column);
    }
  });

  // A run names a registry row or it names nothing: the database is the
  // backstop behind the domain's own refusal of a label.
  it('refuses a run naming a model or prompt version the registry does not hold', async () => {
    await ensureVersions(database.pool, {
      modelVersionId: '00000000-0000-4000-8000-0000000a0003',
      promptVersionId: '00000000-0000-4000-8000-0000000b0007',
    });
    const unregistered = '00000000-0000-4000-8000-0000000fffff';
    expect(await rejects(
      `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
       VALUES ($1, '00000000-0000-4000-8000-0000000b0007', now(), '{}')`, [unregistered])).toContain('generation_run_model_version_fk');
    expect(await rejects(
      `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
       VALUES ('00000000-0000-4000-8000-0000000a0003', $1, now(), '{}')`, [unregistered])).toContain('generation_run_prompt_version_fk');
  });

  it('refuses a label where a version id belongs, on the run and on the candidate', async () => {
    expect(await rejects(`INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
      VALUES ('model-v3', '00000000-0000-4000-8000-0000000b0007', now(), '{}')`)).toContain('uuid');
    const run = await newRun();
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, 'model-v3', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', 0.5)`, [run])).toContain('uuid');
  });

  it('refuses a candidate whose pin disagrees with the run it names', async () => {
    const run = await newRun('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007');
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0008', 'X', '{}', 0.5)`, [run])).toContain('generation_candidate_pin_matches_run');
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0009', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', 0.5)`, [run])).toContain('generation_candidate_pin_matches_run');
  });

  it('refuses a candidate naming a run that does not exist', async () => {
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES (gen_random_uuid(), '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', 0.5)`)).toContain('generation_candidate_pin_matches_run');
  });

  // The question the pin exists to answer, as the one query it is meant to be.
  it('answers “which candidates did prompt v7 produce?” in one query, across runs', async () => {
    const early = await newCandidate(await newRun('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007'), '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007');
    const later = await newCandidate(await newRun('00000000-0000-4000-8000-0000000a0004', '00000000-0000-4000-8000-0000000b0007'), '00000000-0000-4000-8000-0000000a0004', '00000000-0000-4000-8000-0000000b0007');
    const other = await newCandidate(await newRun('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0008'), '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0008');

    const affected = await rows<{ candidate_id: string }>(
      `SELECT candidate_id FROM ai.generation_candidate WHERE prompt_version_id = '00000000-0000-4000-8000-0000000b0007'`,
    );
    const ids = affected.map((row) => row.candidate_id);
    expect(ids).toContain(early);
    expect(ids).toContain(later);
    expect(ids).not.toContain(other);
  });
});

describe('the documents', () => {
  it('requires a JSON object for the request and the proposal, and a positive schema version', async () => {
    await newRun();
    expect(await rejects(`INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request)
      VALUES ('00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', now(), '[1]')`)).toContain('request');
    const run = await newRun();
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '"text"', 0.5)`, [run])).toContain('body');
    expect(await rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, body_schema_version, confidence)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', 0, 0.5)`, [run])).toContain('body_schema_version');
  });

  it('defaults the schema version to 1 on both', async () => {
    const run = await newRun();
    const candidate = await newCandidate(run);
    const [stored] = await rows<{ run_version: number; body_version: number }>(
      `SELECT r.request_schema_version AS run_version, c.body_schema_version AS body_version
         FROM ai.generation_candidate c JOIN ai.generation_run r USING (run_id) WHERE c.candidate_id = $1`,
      [candidate],
    );
    expect(stored).toEqual({ run_version: 1, body_version: 1 });
  });
});

describe('M5-13 — confidence, refused here as the domain refuses it', () => {
  async function insertWithConfidence(runId: string, confidence: string | null): Promise<string> {
    return rejects(
      `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', ${confidence === null ? 'NULL' : `'${confidence}'::float8`})`,
      [runId],
    );
  }

  it('is NOT NULL, with no default to invent one', async () => {
    const [column] = await rows<{ is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'generation_candidate' AND column_name = 'confidence'`,
    );
    expect(column).toEqual({ is_nullable: 'NO', column_default: null, data_type: 'double precision' });
    expect(await insertWithConfidence(await newRun(), null)).toContain('confidence');
  });

  it('refuses below 0, above 1, NaN and infinity — the values the domain refuses', async () => {
    const run = await newRun();
    for (const bad of ['-0.0001', '1.0001', '2', 'NaN', 'Infinity', '-Infinity']) {
      expect(await insertWithConfidence(run, bad), bad).toContain('generation_candidate_confidence_in_unit_interval');
    }
  });

  it('keeps the boundaries, 0 and 1', async () => {
    const run = await newRun();
    for (const ok of ['0', '1', '0.5']) {
      const [stored] = await rows<{ confidence: number }>(
        `INSERT INTO ai.generation_candidate (run_id, model_version_id, prompt_version_id, item_type, body, confidence)
         VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', '${ok}'::float8) RETURNING confidence`,
        [run],
      );
      expect(stored?.confidence).toBe(Number(ok));
    }
  });
});

describe('verdicts and decisions', () => {
  it('stores a verdict once per check, in the order recorded', async () => {
    const candidate = await newCandidate(await newRun());
    await database.pool.query(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'renderability', 'pass', 0)`,
      [candidate],
    );
    expect(await rejects(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'renderability', 'fail', 1)`,
      [candidate])).toContain('candidate_verdict_pkey');
    expect(await rejects(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'syllabus_scope', 'pass', 0)`,
      [candidate])).toContain('candidate_verdict_ordinal_key');
  });

  it('refuses a verdict for a candidate that does not exist, an unknown outcome, or a negative position', async () => {
    const candidate = await newCandidate(await newRun());
    expect(await rejects(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES (gen_random_uuid(), 'renderability', 'pass', 0)`,
    )).toContain('candidate_verdict_candidate_id_fkey');
    expect(await rejects(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'renderability', 'maybe', 0)`,
      [candidate])).toContain('outcome');
    expect(await rejects(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'renderability', 'pass', -1)`,
      [candidate])).toContain('ordinal');
  });

  it('allows one decision per candidate, accepted or rejected', async () => {
    const candidate = await newCandidate(await newRun());
    await database.pool.query(`INSERT INTO ai.candidate_decision (candidate_id, decision) VALUES ($1, 'accepted')`, [candidate]);
    expect(await rejects(`INSERT INTO ai.candidate_decision (candidate_id, decision) VALUES ($1, 'rejected')`, [candidate]))
      .toContain('candidate_decision_pkey');
    const other = await newCandidate(await newRun());
    expect(await rejects(`INSERT INTO ai.candidate_decision (candidate_id, decision) VALUES ($1, 'proposed')`, [other]))
      .toContain('decision');
  });
});

// §9 rule 5: two spellings of one list drift. The domain's vocabulary and the
// schema's CHECK are two; this is the test that asserts they agree.
describe('the schema and the domain agree on the vocabularies', () => {
  async function checkDefinition(table: string, column: string): Promise<string> {
    const [row] = await rows<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ai' AND t.relname = $1 AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || ' = ANY%'`,
      [table, column],
    );
    return row!.definition;
  }

  const quoted = (definition: string): string[] =>
    [...definition.matchAll(/'([a-z_]+)'::text/gu)].map((match) => match[1] as string).sort();

  it('names exactly the twelve pre-checks the domain names', async () => {
    const stored = quoted(await checkDefinition('candidate_verdict', 'check_id'));
    expect(stored).toEqual([...PRECHECK_IDS].sort());
    expect(stored).toHaveLength(12);
  });

  it('names exactly the decided candidate states the domain names', async () => {
    const decided = CANDIDATE_STATES.filter((state) => state !== 'proposed');
    expect(quoted(await checkDefinition('candidate_decision', 'decision'))).toEqual([...decided].sort());
  });
});

describe('conventions shared with the other schemas', () => {
  it('keys every table on a UUID the schema generates, time-ordered', async () => {
    const run = await newRun();
    const [version] = await rows<{ nibble: string }>(`SELECT substr($1::text, 15, 1) AS nibble`, [run]);
    expect(version?.nibble).toBe('7');
  });

  it('defaults tenant_id to the zero UUID', async () => {
    const run = await newRun();
    const [stored] = await rows<{ tenant_id: string }>(`SELECT tenant_id FROM ai.generation_run WHERE run_id = $1`, [run]);
    expect(stored?.tenant_id).toBe('00000000-0000-0000-0000-000000000000');
  });
});
