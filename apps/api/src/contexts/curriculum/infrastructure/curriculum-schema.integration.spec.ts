import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';

let database: TestDatabase;

const EXPECTED_TABLES = [
  'concept_identity',
  'concept_node',
  'exam',
  'exam_profile_version',
  'exam_section_spec',
  'prerequisite_edge',
  'taxonomy_mapping',
  'taxonomy_migration',
  'taxonomy_version',
];

async function tableNames(): Promise<string[]> {
  const result = await database.db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'curriculum' ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

/** Runs raw SQL expected to fail, and returns the PostgreSQL error message. */
async function rejectionMessage(text: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(text, [...params]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

async function seedVersion(): Promise<string> {
  const inserted = await database.db.execute<{ taxonomy_version_id: string }>(sql`
    INSERT INTO curriculum.taxonomy_version (exam_family, academic_year)
    VALUES ('JEE', '2026') RETURNING taxonomy_version_id
  `);
  return inserted.rows[0]?.taxonomy_version_id as string;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

afterAll(async () => {
  await database.close();
});

describe('curriculum migration', () => {
  it('applies to a clean database and creates all nine tables', async () => {
    expect(await tableNames()).toEqual(EXPECTED_TABLES);
  });

  it('reverses cleanly and re-applies', async () => {
    await database.revertMigrations();

    const afterDown = await database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM information_schema.schemata WHERE schema_name = 'curriculum'
    `);
    expect(afterDown.rows[0]?.count).toBe('0');

    await database.applyMigrations();
    expect(await tableNames()).toEqual(EXPECTED_TABLES);
  });

  it('generates time-ordered UUIDv7 keys', async () => {
    const first = await seedVersion();
    const second = await seedVersion();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    // The leading 48 bits are the millisecond timestamp; the rest is random, so
    // only the timestamp prefix is ordered.
    const timestampOf = (id: string): string => id.slice(0, 8) + id.slice(9, 13);
    expect(timestampOf(second) >= timestampOf(first)).toBe(true);
    await database.truncateAll();
  });

  it('defaults tenant_id to the platform tenant on every tenancy-scoped table', async () => {
    const result = await database.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'curriculum' AND column_name = 'tenant_id' ORDER BY table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'concept_identity',
      'exam',
      'exam_profile_version',
      'taxonomy_migration',
      'taxonomy_version',
    ]);
  });

  it('carries aggregate_version on every aggregate root', async () => {
    const result = await database.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'curriculum' AND column_name = 'aggregate_version' ORDER BY table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'concept_identity',
      'exam',
      'exam_profile_version',
      'taxonomy_migration',
      'taxonomy_version',
    ]);
  });
});

describe('fitness function F2 — no foreign key crosses a schema boundary', () => {
  it('finds no cross-schema foreign key anywhere in the database', async () => {
    const result = await database.db.execute<{ constraint_name: string; child: string; parent: string }>(sql`
      SELECT con.conname AS constraint_name,
             child_ns.nspname AS child,
             parent_ns.nspname AS parent
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE con.contype = 'f' AND child_ns.nspname <> parent_ns.nspname
    `);

    expect(result.rows).toEqual([]);
  });

  it('has foreign keys inside the curriculum schema', async () => {
    const result = await database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      WHERE con.contype = 'f' AND ns.nspname = 'curriculum'
    `);

    expect(Number(result.rows[0]?.count)).toBeGreaterThanOrEqual(11);
  });
});

describe('fitness function F5 — every JSONB column has a sibling schema version', () => {
  it('finds no JSONB column without a *_schema_version sibling', async () => {
    const result = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT j.table_name, j.column_name
      FROM information_schema.columns j
      WHERE j.table_schema = 'curriculum' AND j.data_type = 'jsonb'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns v
          WHERE v.table_schema = j.table_schema AND v.table_name = j.table_name
            AND v.column_name = j.column_name || '_schema_version'
        )
    `);

    expect(result.rows).toEqual([]);
  });

  it('covers the four policy columns named in the task', async () => {
    const result = await database.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'curriculum' AND data_type = 'jsonb' ORDER BY column_name
    `);

    const columns = result.rows.map((row) => row.column_name);
    expect(columns).toContain('timing_policy');
    expect(columns).toContain('navigation_policy');
    expect(columns).toContain('marking_rule_set');
    expect(columns).toContain('tolerance_defaults');
  });
});

describe('referential integrity', () => {
  it('rejects a concept node whose taxonomy version does not exist', async () => {
    const identityVersion = await seedVersion();
    const identity = await database.db.execute<{ concept_identity_id: string }>(sql`
      INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
      VALUES ('Mechanics', 'physics', ${identityVersion}) RETURNING concept_identity_id
    `);

    const message = await rejectionMessage(
      `INSERT INTO curriculum.concept_node
         (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
       VALUES ('00000000-0000-0000-0000-0000000000ff', $1, 'Mechanics', 0.2, 0, 10)`,
      [identity.rows[0]?.concept_identity_id],
    );

    expect(message).toMatch(/violates foreign key constraint/u);

    await database.truncateAll();
  });

  it('rejects a duplicate concept identity within one taxonomy version', async () => {
    const versionId = await seedVersion();
    const identity = await database.db.execute<{ concept_identity_id: string }>(sql`
      INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
      VALUES ('Mechanics', 'physics', ${versionId}) RETURNING concept_identity_id
    `);
    const conceptId = identity.rows[0]?.concept_identity_id as string;

    await database.db.execute(sql`
      INSERT INTO curriculum.concept_node
        (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
      VALUES (${versionId}, ${conceptId}, 'Mechanics', 0.2, 0, 10)
    `);

    const message = await rejectionMessage(
      `INSERT INTO curriculum.concept_node
         (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
       VALUES ($1, $2, 'Mechanics again', 0.2, 1, 10)`,
      [versionId, conceptId],
    );

    expect(message).toMatch(/concept_node_identity_unique_per_version/u);

    await database.truncateAll();
  });

  it('rejects a self-referencing prerequisite edge', async () => {
    const versionId = await seedVersion();
    const identity = await database.db.execute<{ concept_identity_id: string }>(sql`
      INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
      VALUES ('Vectors', 'physics', ${versionId}) RETURNING concept_identity_id
    `);
    const conceptId = identity.rows[0]?.concept_identity_id as string;

    const message = await rejectionMessage(
      `INSERT INTO curriculum.prerequisite_edge
         (taxonomy_version_id, from_concept_identity_id, to_concept_identity_id, strength)
       VALUES ($1, $2, $2, 0.5)`,
      [versionId, conceptId],
    );

    expect(message).toMatch(/prerequisite_edge_not_self_referencing/u);

    await database.truncateAll();
  });

  it('rejects an exam weight outside [0, 1] and an out-of-range strength', async () => {
    const versionId = await seedVersion();
    const identity = await database.db.execute<{ concept_identity_id: string }>(sql`
      INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
      VALUES ('Optics', 'physics', ${versionId}) RETURNING concept_identity_id
    `);

    const message = await rejectionMessage(
      `INSERT INTO curriculum.concept_node
         (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
       VALUES ($1, $2, 'Optics', 1.5, 0, 10)`,
      [versionId, identity.rows[0]?.concept_identity_id],
    );

    expect(message).toMatch(/exam_weight/u);

    await database.truncateAll();
  });

  it('rejects a duplicate exam code within a tenant', async () => {
    await database.db.execute(sql`
      INSERT INTO curriculum.exam (code, display_name, jurisdiction, conducting_body)
      VALUES ('JEE_MAIN', 'JEE Main', 'IN', 'NTA')
    `);

    const message = await rejectionMessage(
      `INSERT INTO curriculum.exam (code, display_name, jurisdiction, conducting_body)
       VALUES ('JEE_MAIN', 'JEE Main duplicate', 'IN', 'NTA')`,
    );

    expect(message).toMatch(/exam_code_unique_per_tenant/u);

    await database.truncateAll();
  });

  it('rejects a mapping whose cardinality does not match its kind', async () => {
    const from = await seedVersion();
    const to = await seedVersion();
    const migration = await database.db.execute<{ migration_id: string }>(sql`
      INSERT INTO curriculum.taxonomy_migration (from_version, to_version)
      VALUES (${from}, ${to}) RETURNING migration_id
    `);

    const message = await rejectionMessage(
      `INSERT INTO curriculum.taxonomy_mapping (migration_id, ordinal, kind, from_ids, to_ids)
       VALUES ($1, 0, 'split', ARRAY['00000000-0000-0000-0000-000000000001']::uuid[],
               ARRAY['00000000-0000-0000-0000-000000000002']::uuid[])`,
      [migration.rows[0]?.migration_id],
    );

    expect(message).toMatch(/taxonomy_mapping_cardinality/u);

    await database.truncateAll();
  });

  it('permits at most one active profile version per exam and academic year', async () => {
    const versionId = await seedVersion();
    const examRow = await database.db.execute<{ exam_id: string }>(sql`
      INSERT INTO curriculum.exam (code, display_name, jurisdiction, conducting_body)
      VALUES ('NEET_UG', 'NEET UG', 'IN', 'NTA') RETURNING exam_id
    `);
    const examId = examRow.rows[0]?.exam_id as string;

    const insertActive = `INSERT INTO curriculum.exam_profile_version
        (exam_id, academic_year, state, taxonomy_version_id, total_marks, timing_policy, navigation_policy,
         marking_rule_set, marking_rule_set_hash, item_type_allowances, is_active, published_at,
         published_by_kind, published_by_id)
      VALUES ($1, '2026', 'published', $2, 720, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'hash',
              '[]'::jsonb, true, now(), 'human', '00000000-0000-0000-0000-00000000000a')`;

    await database.pool.query(insertActive, [examId, versionId]);
    const message = await rejectionMessage(insertActive, [examId, versionId]);

    expect(message).toMatch(/exam_profile_version_one_active_per_year_idx/u);

    await database.truncateAll();
  });
});
