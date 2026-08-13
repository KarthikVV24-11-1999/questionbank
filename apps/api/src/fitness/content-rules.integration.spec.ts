import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  checkJsonbVersionSiblings,
  checkNoTruncateGrant,
  type ColumnRow,
  type GrantRow,
} from './content-rules.js';

/**
 * The two M3 gates that can only be answered by the database (§5: real
 * Postgres, never a mock).
 *
 *   F5     — every content JSONB column has a sibling `*_schema_version`
 *   F7/F40 — no TRUNCATE grant on a published-version table
 *
 * The SQL lives here and the judgment lives in `content-rules.ts`, so the same
 * rule that runs against the real catalogue is the one the unit spec runs
 * against a planted violation.
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

const PUBLISHED_VERSION_TABLES = [
  'item_version',
  'item_option',
  'item_numeric_spec',
  'item_taxonomy_tag',
  'item_provenance',
  'stimulus_version',
  'solution_version',
  'solution_step',
  'media_asset_version',
];

describe('F5 — every content JSONB column has a version sibling', () => {
  it('holds across the whole content schema, over a catalogue that is not empty', async () => {
    const { rows } = await database.pool.query<ColumnRow>(
      `SELECT table_name AS "table", column_name AS "column", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'content'`,
    );

    expect(rows.filter((row) => row.dataType === 'jsonb').length).toBeGreaterThanOrEqual(9);
    expect(checkJsonbVersionSiblings(rows)).toEqual([]);
  });

  // The instrument, on the same shape of data: dropping a real sibling from the
  // catalogue rows makes the check fire, so a green result is a fact about the
  // schema rather than about the query returning nothing.
  it('fires when a real sibling is taken away', async () => {
    const { rows } = await database.pool.query<ColumnRow>(
      `SELECT table_name AS "table", column_name AS "column", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'content'`,
    );
    const weakened = rows.filter((row) => row.column !== 'stem_body_schema_version');

    expect(checkJsonbVersionSiblings(weakened).map((violation) => violation.subject)).toContain(
      'item_version.stem_body',
    );
  });
});

describe('F7/F40 — no TRUNCATE grant on a published-version table', () => {
  /**
   * The role the deployed application connects as. **It does not exist on a
   * local instance** — there is no Compose stack here (ADR-0004) — so this is
   * recorded rather than passed over, exactly as M3-20's grant test does. A
   * check that treated whatever grantee it happened to find as "the app role"
   * would call the table owner a violation and teach the wrong lesson twice.
   */
  const APP_ROLE = 'questionbank_app';

  it('reports honestly that the deployment role is absent on this instance', async () => {
    const { rows } = await database.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
      [APP_ROLE],
    );
    expect(rows[0]?.exists).toBe(false);
  });

  it('finds no TRUNCATE held by the application role', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'content' AND table_name = ANY($1)`,
      [PUBLISHED_VERSION_TABLES],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.table)).size).toBe(PUBLISHED_VERSION_TABLES.length);
    expect(checkNoTruncateGrant(rows, [APP_ROLE])).toEqual([]);
  });

  // Which, locally, is a result about a role that is not there. So the check is
  // shown to fire on the same catalogue rows with the grant present.
  it('fires when the application role does hold TRUNCATE', () => {
    const violations = checkNoTruncateGrant(
      [
        { table: 'item_version', privilege: 'TRUNCATE', grantee: APP_ROLE },
        { table: 'item_version', privilege: 'UPDATE', grantee: APP_ROLE },
      ],
      [APP_ROLE],
    );
    expect(violations).toEqual([
      {
        rule: 'F7_WRITE_GRANT_ON_A_PUBLISHED_VERSION_TABLE',
        subject: 'item_version',
        detail: `${APP_ROLE} holds TRUNCATE`,
      },
    ]);
  });

  // UPDATE and DELETE are deliberately *kept*: a content version is editable
  // while a draft and frozen from publication, which is what the draft state is
  // for. The trigger holds INV-03 for rows; the grant is the control only for
  // TRUNCATE, which a row trigger cannot see (M3-20).
  it('does not object to the row privileges drafts need', () => {
    expect(
      checkNoTruncateGrant(
        [
          { table: 'item_version', privilege: 'UPDATE', grantee: APP_ROLE },
          { table: 'item_version', privilege: 'DELETE', grantee: APP_ROLE },
        ],
        [APP_ROLE],
      ),
    ).toEqual([]);
  });
});
