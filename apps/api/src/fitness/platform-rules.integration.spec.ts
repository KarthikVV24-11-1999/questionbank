import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  COLUMN_GRANTS_SQL,
  COLUMN_UPDATE_ALLOWLIST,
  checkColumnUpdateGrants,
  checkNoTruncateGrant,
  checkNoWriteGrantOnAppendOnlyTable,
  type ColumnGrantRow,
  type GrantRow,
} from './content-rules.js';

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

describe('F40 sees column grants too (M6-45)', () => {
  const SCHEMAS = ['content', 'curriculum', 'scoring', 'platform', 'ai', 'assessment'];
  const columnGrants = async (client: { query: (sql: string, params: unknown[]) => Promise<{ rows: ColumnGrantRow[] }> } = database.pool) =>
    (await client.query(COLUMN_GRANTS_SQL, [SCHEMAS])).rows;

  it('finds the outbox\'s six delivery columns and the attempt\'s seven lifecycle columns, and nothing else, against the real catalogue', async () => {
    const rows = await columnGrants();
    const update = rows.filter((row) => row.privilege === 'UPDATE' && row.grantee === APP_ROLE);
    expect(update.map((row) => `${row.table}.${row.column}`)).toEqual([
      'assessment.attempt.abandoned_at',
      'assessment.attempt.deadline_at',
      'assessment.attempt.idempotency_key',
      'assessment.attempt.started_at',
      'assessment.attempt.state',
      'assessment.attempt.submission_reason',
      'assessment.attempt.submitted_at',
      'platform.outbox_message.attempts',
      'platform.outbox_message.claimed_until',
      'platform.outbox_message.dead_at',
      'platform.outbox_message.last_error',
      'platform.outbox_message.published_at',
      'platform.outbox_message.retry_at',
    ]);
    // and the allow-list holds exactly those, both ways
    expect(checkColumnUpdateGrants(rows, [APP_ROLE])).toEqual([]);
    expect(Object.keys(COLUMN_UPDATE_ALLOWLIST)).toEqual(['platform.outbox_message', 'assessment.attempt']);
  });

  it('does not mistake a table-level grant for a column one: the read is of what was granted on a column itself', async () => {
    const rows = await columnGrants();
    // content.item_version carries a table-level UPDATE for the app role, and it must not appear here as thirty column grants
    expect(rows.filter((row) => row.table === 'content.item_version')).toEqual([]);
    const tableLevel = await database.pool.query(
      `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'content' AND table_name = 'item_version' AND grantee = $1 AND privilege_type = 'UPDATE'`,
      [APP_ROLE],
    );
    expect(tableLevel.rowCount).toBe(1);
  });

  /** Plants a grant in a transaction and rolls it back, so the catalogue the other specs read is never touched. */
  async function withPlanted(grant: string, check: (rows: ColumnGrantRow[]) => void): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(grant);
      check(await columnGrants(client));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('fires on a grant of the attempt\'s pinned mode, added in a rolled-back transaction (M7-25)', async () => {
    await withPlanted(`GRANT UPDATE (mode, delivery_policy) ON assessment.attempt TO ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE])).toEqual([
        expect.objectContaining({ rule: 'F40_COLUMN_UPDATE_NOT_ON_THE_ALLOW_LIST', subject: 'assessment.attempt.delivery_policy' }),
        expect.objectContaining({ rule: 'F40_COLUMN_UPDATE_NOT_ON_THE_ALLOW_LIST', subject: 'assessment.attempt.mode' }),
      ]);
    });
  });

  it('fires on a seventh column of the outbox, added in a rolled-back transaction', async () => {
    await withPlanted(`GRANT UPDATE (payload) ON platform.outbox_message TO ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE])).toEqual([
        expect.objectContaining({ rule: 'F40_COLUMN_UPDATE_NOT_ON_THE_ALLOW_LIST', subject: 'platform.outbox_message.payload' }),
      ]);
    });
    expect(checkColumnUpdateGrants(await columnGrants(), [APP_ROLE])).toEqual([]);
  });

  it('fires on a column UPDATE on a published-version table — the case that matters more than the outbox', async () => {
    await withPlanted(`GRANT UPDATE (stem_body) ON content.item_version TO ${APP_ROLE}`, (rows) => {
      const found = checkColumnUpdateGrants(rows, [APP_ROLE]);
      expect(found).toEqual([expect.objectContaining({ rule: 'F40_COLUMN_UPDATE_NOT_ON_THE_ALLOW_LIST', subject: 'content.item_version.stem_body' })]);
    });
    await withPlanted(`GRANT UPDATE (published_at) ON content.stimulus_version TO ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE]).map((violation) => violation.subject)).toEqual(['content.stimulus_version.published_at']);
    });
  });

  it('fires on the audit chain and the exposure ledger too, which have no whole-row trigger to fall back on', async () => {
    await withPlanted(`GRANT UPDATE (action) ON platform.audit_record TO ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE]).map((violation) => violation.subject)).toEqual(['platform.audit_record.action']);
    });
    await withPlanted(`GRANT UPDATE (is_anchor) ON assessment.exposure_ledger_entry TO ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE]).map((violation) => violation.subject)).toEqual(['assessment.exposure_ledger_entry.is_anchor']);
    });
  });

  it('fires when one of the six is revoked: five is as wrong as seven', async () => {
    await withPlanted(`REVOKE UPDATE (last_error) ON platform.outbox_message FROM ${APP_ROLE}`, (rows) => {
      expect(checkColumnUpdateGrants(rows, [APP_ROLE])).toEqual([
        expect.objectContaining({ rule: 'F40_COLUMN_UPDATE_ALLOW_LIST_NOT_HELD', subject: 'platform.outbox_message.last_error' }),
      ]);
    });
  });
});
