import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import { checkNoTruncateGrant, checkNoWriteGrantOnAppendOnlyTable, type GrantRow } from './content-rules.js';

/**
 * F7/F40, at the platform level rather than content's own (M0-24, closes
 * D9). `content-rules.integration.spec.ts` proves the role and its content
 * grants in full; this proves the same role's grants hold across
 * curriculum, scoring and platform too — the migration is one role granted
 * once, not four copies that could quietly diverge.
 */
const APP_ROLE = 'questionbank_app';

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

describe('questionbank_app — no TRUNCATE anywhere, in the real catalogue', () => {
  it('holds no TRUNCATE across content, curriculum, scoring or platform', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE grantee = $1`,
      [APP_ROLE],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(checkNoTruncateGrant(rows, [APP_ROLE])).toEqual([]);
  });
});

describe('questionbank_app — curriculum keeps the row privileges drafts need', () => {
  it('holds UPDATE and DELETE on curriculum.taxonomy_version, against the real catalogue', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'curriculum' AND table_name = 'taxonomy_version' AND grantee = $1`,
      [APP_ROLE],
    );

    const privileges = new Set(rows.map((row) => row.privilege));
    expect(privileges.has('UPDATE')).toBe(true);
    expect(privileges.has('DELETE')).toBe(true);
  });
});

describe('platform stays append-only for every table, not only audit_record', () => {
  it('finds no UPDATE/DELETE/TRUNCATE anywhere in the platform schema, against the real catalogue', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND grantee = $1`,
      [APP_ROLE],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(checkNoWriteGrantOnAppendOnlyTable(rows, [APP_ROLE])).toEqual([]);
  });
});
