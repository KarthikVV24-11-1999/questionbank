import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  checkJsonbVersionSiblings,
  checkNoTruncateGrant,
  checkNoWriteGrantOnAppendOnlyTable,
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
   * The role the deployed application connects as. **It now exists on a
   * local instance** (M0-24, closes D9) — the migration creates it — so this
   * test is rewritten to assert the real thing rather than left recording an
   * absence that stopped being true. Leaving it asserting a falsehood would
   * be worse than having no test (DEC-M0-14 rule 3).
   */
  const APP_ROLE = 'questionbank_app';

  it('exists, locally, as the migration creates it', async () => {
    const { rows } = await database.pool.query<{ exists: boolean; canLogin: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS "canLogin"`,
      [APP_ROLE],
    );
    expect(rows[0]?.exists).toBe(true);
    // NOLOGIN locally — no password in source (F39); the deployed credential
    // is set out of band, from Secrets Manager, never by this migration.
    expect(rows[0]?.canLogin).toBe(false);
  });

  it('holds exactly the expected privilege set — SELECT/INSERT/UPDATE/DELETE on content/curriculum/scoring, SELECT/INSERT only on platform', async () => {
    const { rows } = await database.pool.query<GrantRow & { schema: string }>(
      `SELECT table_schema AS "schema", table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema IN ('content', 'curriculum', 'scoring', 'platform')`,
      [APP_ROLE],
    );

    expect(rows.length).toBeGreaterThan(0);

    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = `${row.schema}.${row.table}`;
      const set = byTable.get(key) ?? new Set<string>();
      set.add(row.privilege);
      byTable.set(key, set);
    }

    for (const [table, privileges] of byTable) {
      expect(privileges.has('TRUNCATE'), table).toBe(false);
      if (table.startsWith('platform.')) {
        expect([...privileges].sort(), table).toEqual(['INSERT', 'SELECT']);
      } else {
        expect(privileges.has('SELECT'), table).toBe(true);
        expect(privileges.has('INSERT'), table).toBe(true);
        expect(privileges.has('UPDATE'), table).toBe(true);
        expect(privileges.has('DELETE'), table).toBe(true);
      }
    }
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

  // A real result about a role that now really exists (M0-24) — so the check
  // is also shown to fire on the same catalogue shape with the grant present,
  // the first time F7/F40 has ever fired against a real role rather than a
  // planted row alone.
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

describe('F40 — no UPDATE/DELETE/TRUNCATE on an append-only platform table', () => {
  const APP_ROLE = 'questionbank_app';

  it('finds none held on platform.audit_record, against the real catalogue', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'audit_record'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(checkNoWriteGrantOnAppendOnlyTable(rows, [APP_ROLE])).toEqual([]);
  });

  it('fires when the application role holds UPDATE on platform.audit_record', () => {
    const violations = checkNoWriteGrantOnAppendOnlyTable(
      [{ table: 'audit_record', privilege: 'UPDATE', grantee: APP_ROLE }],
      [APP_ROLE],
    );
    expect(violations).toEqual([
      { rule: 'F40_WRITE_GRANT_ON_AN_APPEND_ONLY_TABLE', subject: 'audit_record', detail: `${APP_ROLE} holds UPDATE` },
    ]);
  });
});
