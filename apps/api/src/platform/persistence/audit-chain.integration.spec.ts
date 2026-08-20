import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, DATABASE_URL, type TestDatabase } from '../../testing/database.js';
import {
  AUDIT_LINK_COLUMNS,
  CHAIN_COLUMNS,
  canonicalize,
  GENESIS_PREV_HASH,
  recordHash,
  type AuditLinkRecord,
} from './audit-link.js';
import { expectedRecordHash, readChainHead, readChainPage } from './audit-chain.js';

/**
 * M4-23. The chain is computed in the database; this asserts it computes the
 * same thing `audit-link.ts` specifies.
 *
 * **The drift risk is the point of this file** (rule 5 — two implementations
 * of one rule will drift, and this project has been bitten three times). The
 * fixture set below is deliberately the three shapes that break a naive
 * canonicalizer: everything populated, every nullable column NULL, and both
 * nullable columns at their empty/zero value.
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

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-b000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

interface InsertShape {
  readonly auditRecordId?: string;
  readonly targetVersion?: number | null;
  readonly justification?: string | null;
  readonly occurredAt?: string;
  readonly action?: string;
}

async function insertAuditRecord(shape: InsertShape = {}): Promise<string> {
  const id = shape.auditRecordId ?? freshUuid();
  await database.pool.query(
    `INSERT INTO platform.audit_record
       (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
        target_id, target_version, correlation_id, occurred_at, justification)
     VALUES ($1, 'human', $2, $3, 'content', 'Item', $4, $5, $6, $7::timestamptz, $8)`,
    [
      id,
      freshUuid(),
      shape.action ?? 'PublishItemVersion',
      freshUuid(),
      shape.targetVersion === undefined ? 3 : shape.targetVersion,
      `corr-${uuidSeed}`,
      shape.occurredAt ?? '2026-08-20T09:00:00.123456Z',
      shape.justification === undefined ? 'because the key was wrong' : shape.justification,
    ],
  );
  return id;
}

/** The SQL side's canonical bytes for one stored row, straight from the trigger's own function. */
async function sqlCanonical(auditRecordId: string): Promise<Buffer> {
  const found = await database.pool.query<{ canonical: Buffer }>(
    `SELECT platform.audit_record_canonical(a) AS canonical
       FROM platform.audit_record a WHERE a.audit_record_id = $1`,
    [auditRecordId],
  );
  return found.rows[0]!.canonical;
}

/**
 * One stored row, read through the same projection the verifier uses — so a
 * mistake in `SELECT_CHAIN_ROW` fails here rather than only in production.
 */
async function readOne(
  auditRecordId: string,
): Promise<{ record: AuditLinkRecord; prevHash: Buffer; recordHash: Buffer }> {
  const rows = await readChainPage(database.pool, 1, 10_000);
  const found = rows.find((row) => row.record.auditRecordId === auditRecordId);
  if (found === undefined) throw new Error(`no audit record ${auditRecordId}`);
  return { record: found.record, prevHash: found.prevHash, recordHash: found.recordHash };
}

describe('every insert is chained by the database, not by the caller', () => {
  it('assigns chain_seq, prev_hash and record_hash without the application supplying one', async () => {
    const id = await insertAuditRecord();
    const found = await database.pool.query<{ chain_seq: string; prev_hash: Buffer; record_hash: Buffer }>(
      `SELECT chain_seq, prev_hash, record_hash FROM platform.audit_record WHERE audit_record_id = $1`,
      [id],
    );
    const row = found.rows[0]!;
    expect(Number(row.chain_seq)).toBeGreaterThan(0);
    expect(row.prev_hash).toHaveLength(32);
    expect(row.record_hash).toHaveLength(32);
  });

  it('links each record to its predecessor, and the first to the all-zero genesis hash', async () => {
    // A fresh chain: everything before this point is dropped so seq 1 is genuinely first.
    await database.revertMigrations();
    await database.applyMigrations();

    const ids = [await insertAuditRecord(), await insertAuditRecord(), await insertAuditRecord()];
    const page = await readChainPage(database.pool, 1, 100);

    expect(page.map((row) => row.chainSeq)).toEqual([1, 2, 3]);
    expect(page[0]!.prevHash.equals(GENESIS_PREV_HASH)).toBe(true);
    expect(page[1]!.prevHash.equals(page[0]!.recordHash)).toBe(true);
    expect(page[2]!.prevHash.equals(page[1]!.recordHash)).toBe(true);
    expect(page.map((row) => row.record.auditRecordId)).toEqual(ids);
  });

  it('a caller that tries to supply its own link has it overwritten by the trigger', async () => {
    const id = freshUuid();
    const forged = Buffer.alloc(32, 0xff);
    await database.pool.query(
      `INSERT INTO platform.audit_record
         (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
          target_id, correlation_id, occurred_at, chain_seq, prev_hash, record_hash)
       VALUES ($1, 'human', $2, 'A', 'content', 'Item', $3, 'c', now(), 999999, $4, $4)`,
      [id, freshUuid(), freshUuid(), forged],
    );

    const found = await database.pool.query<{ chain_seq: string; record_hash: Buffer }>(
      `SELECT chain_seq, record_hash FROM platform.audit_record WHERE audit_record_id = $1`,
      [id],
    );
    expect(Number(found.rows[0]!.chain_seq)).not.toBe(999_999);
    expect(found.rows[0]!.record_hash.equals(forged)).toBe(false);
  });
});

describe('the SQL canonicalization is byte-identical to the TypeScript specification', () => {
  /**
   * The three shapes that break a naive canonicalizer. `nullableEmpty` is the
   * one that matters most: without a length prefix that distinguishes `-1`
   * from `0`, a NULL and an empty string serialize the same and a NULL/empty
   * swap is an undetected tamper.
   */
  const FIXTURES: Readonly<Record<string, InsertShape>> = {
    full: { targetVersion: 3, justification: 'a real justification' },
    allNullableNull: { targetVersion: null, justification: null },
    nullableEmpty: { targetVersion: 0, justification: '' },
    unicodeAndMicroseconds: {
      justification: 'κλειδί — «правильный» ✓ multi-byte',
      occurredAt: '2026-08-20T23:59:59.999999Z',
    },
    midnightMicrosecondZero: { occurredAt: '2026-08-20T00:00:00.000000Z' },
  };

  for (const [name, shape] of Object.entries(FIXTURES)) {
    it(`agrees on the canonical bytes for the ${name} fixture`, async () => {
      const id = await insertAuditRecord(shape);
      const fromSql = await sqlCanonical(id);
      const { record } = await readOne(id);
      const fromTs = canonicalize(record);

      expect(fromTs.toString('utf8')).toBe(fromSql.toString('utf8'));
      expect(fromTs.equals(fromSql)).toBe(true);
    });

    it(`agrees on the full link hash for the ${name} fixture`, async () => {
      const id = await insertAuditRecord(shape);
      const { record, prevHash, recordHash: stored } = await readOne(id);
      expect(recordHash(prevHash, record).equals(stored)).toBe(true);
    });
  }

  it('carries microseconds through both implementations rather than truncating to milliseconds', async () => {
    const id = await insertAuditRecord({ occurredAt: '2026-08-20T09:00:00.123456Z' });
    const { record } = await readOne(id);
    // The precision the driver would have silently dropped had this been
    // read as a Date. Verified against Postgres 16, not assumed.
    expect(record.occurredAt).toBe('2026-08-20T09:00:00.123456Z');
    expect(canonicalize(record).equals(await sqlCanonical(id))).toBe(true);
  });

  it('distinguishes NULL from empty on the SQL side too, not only in TypeScript', async () => {
    const asNull = await insertAuditRecord({ justification: null, targetVersion: null });
    const asEmpty = await insertAuditRecord({ justification: '', targetVersion: 0 });
    const nullBytes = (await sqlCanonical(asNull)).toString('utf8');
    const emptyBytes = (await sqlCanonical(asEmpty)).toString('utf8');
    expect(nullBytes).toContain('-1:');
    expect(emptyBytes).not.toContain('-1:');
  });
});

describe('the canonicalized column set is exactly the table minus the chain columns', () => {
  /**
   * The catalogue drift guard. A column added to `platform.audit_record` by a
   * later migration that nobody adds to `audit-link.ts` silently falls out of
   * chain coverage — every other test in this file stays green, because they
   * all compare two implementations that would both be ignoring it. This is
   * the one that notices.
   */
  it('matches information_schema, so a new column cannot fall out of coverage unnoticed', async () => {
    const found = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'audit_record'
        ORDER BY ordinal_position`,
    );
    const inTable = found.rows.map((row) => row.column_name);
    const expected = inTable.filter((name) => !(CHAIN_COLUMNS as readonly string[]).includes(name));

    expect([...AUDIT_LINK_COLUMNS].sort()).toEqual([...expected].sort());
    // Not vacuous: the table really does carry the three chain columns.
    for (const column of CHAIN_COLUMNS) expect(inTable).toContain(column);
  });
});

describe('concurrent inserts produce a gapless total order', () => {
  it('two connections inserting at once leave no gap and no duplicate', async () => {
    await database.revertMigrations();
    await database.applyMigrations();

    const poolA = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const poolB = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const insert = (pool: Pool) =>
      pool.query(
        `INSERT INTO platform.audit_record
           (principal_kind, principal_id, action, target_context, target_type, target_id,
            correlation_id, occurred_at)
         VALUES ('human', gen_random_uuid()::text, 'A', 'content', 'Item', gen_random_uuid()::text,
                 'c', now())`,
      );

    try {
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 12; i += 1) writes.push(insert(i % 2 === 0 ? poolA : poolB));
      await Promise.all(writes);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    const page = await readChainPage(database.pool, 1, 1000);
    expect(page).toHaveLength(12);
    // Gapless: 1..12 with no repeats, which the unique constraint alone
    // would not give — it forbids duplicates, not gaps.
    expect(page.map((row) => row.chainSeq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    // And every link still verifies against its predecessor.
    let previous = null as (typeof page)[number] | null;
    for (const row of page) {
      expect(expectedRecordHash(row, previous).equals(row.recordHash)).toBe(true);
      previous = row;
    }
  });
});

describe('the backfill leaves a verifying chain, with no pre-history hole', () => {
  it('chains rows that existed before the migration ran, in audit_record_id order', async () => {
    // Take the chain off, write history behind its back, put it back on.
    await database.revertMigrations();
    await database.applyMigrations();
    await database.pool.query(`DROP TRIGGER audit_record_chain ON platform.audit_record`);
    await database.pool.query(
      `ALTER TABLE platform.audit_record
         DROP COLUMN record_hash, DROP COLUMN prev_hash, DROP COLUMN chain_seq`,
    );

    const preExisting = ['00000000-0000-4000-c000-000000000001', '00000000-0000-4000-c000-000000000002'];
    for (const id of preExisting) {
      await database.pool.query(
        `INSERT INTO platform.audit_record
           (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
            target_id, correlation_id, occurred_at)
         VALUES ($1, 'human', $2, 'PreHistory', 'content', 'Item', $3, 'c', now())`,
        [id, freshUuid(), freshUuid()],
      );
    }

    // Re-run only the chain migration's up path.
    const { readMigrations } = await import('../../testing/database.js');
    const chain = readMigrations().find((m) => m.name.includes('platform_audit_chain'))!;
    await database.pool.query(chain.up);

    const page = await readChainPage(database.pool, 1, 100);
    expect(page.map((row) => row.record.auditRecordId)).toEqual(preExisting);
    expect(page[0]!.prevHash.equals(GENESIS_PREV_HASH)).toBe(true);

    let previous = null as (typeof page)[number] | null;
    for (const row of page) {
      expect(expectedRecordHash(row, previous).equals(row.recordHash)).toBe(true);
      previous = row;
    }

    // And a record inserted afterwards continues the same chain rather than restarting it.
    await insertAuditRecord();
    const head = await readChainHead(database.pool);
    expect(head!.chainSeq).toBe(3);
    expect(head!.prevHash.equals(page[1]!.recordHash)).toBe(true);
  });
});

describe('the guarantees the chain must not have weakened', () => {
  it('the append-only trigger still rejects an UPDATE', async () => {
    const id = await insertAuditRecord();
    await expect(
      database.pool.query(`UPDATE platform.audit_record SET action = 'x' WHERE audit_record_id = $1`, [id]),
    ).rejects.toThrow(/audit_record_is_append_only/u);
  });

  it('the append-only trigger still rejects a DELETE', async () => {
    const id = await insertAuditRecord();
    await expect(
      database.pool.query(`DELETE FROM platform.audit_record WHERE audit_record_id = $1`, [id]),
    ).rejects.toThrow(/audit_record_is_append_only/u);
  });

  it('leaves the backfill with the append-only trigger enabled, not disabled', async () => {
    const found = await database.pool.query<{ tgenabled: string }>(
      `SELECT t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relname = 'audit_record'
          AND t.tgname = 'audit_record_append_only'`,
    );
    // 'O' is origin-enabled; 'D' would mean the migration left it switched off.
    expect(found.rows[0]!.tgenabled).toBe('O');
  });

  it('the app role still holds no UPDATE, DELETE or TRUNCATE on audit_record', async () => {
    const found = await database.pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'audit_record'
          AND grantee = 'questionbank_app'`,
    );
    const held = found.rows.map((row) => row.privilege_type).sort();
    expect(held).toEqual(['INSERT', 'SELECT']);
  });

  it('carries a UNIQUE constraint on chain_seq, so a duplicate cannot be stored at all', async () => {
    const found = await database.pool.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'platform' AND t.relname = 'audit_record'
          AND c.contype = 'u' AND c.conname = 'audit_record_chain_seq_unique'`,
    );
    expect(found.rowCount).toBe(1);
  });

  /**
   * The constraint is proven able to fire the only way it can be, since the
   * trigger overwrites any `chain_seq` a caller supplies: disable the trigger
   * for the length of one rolled-back transaction and write the collision by
   * hand. Without the constraint this INSERT would succeed.
   */
  it('refuses a duplicate chain_seq written behind the trigger’s back', async () => {
    const head = await readChainHead(database.pool);
    const client = await database.pool.connect();
    let message = '';
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE platform.audit_record DISABLE TRIGGER audit_record_chain`);
      await client.query(
        `INSERT INTO platform.audit_record
           (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
            target_id, correlation_id, occurred_at, chain_seq, prev_hash, record_hash)
         VALUES ($1, 'human', $2, 'A', 'content', 'Item', $3, 'c', now(), $4, $5, $5)`,
        [freshUuid(), freshUuid(), freshUuid(), head!.chainSeq, Buffer.alloc(32, 1)],
      );
    } catch (error) {
      message = (error as Error).message;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(message).toContain('audit_record_chain_seq_unique');
  });
});

describe('the read path refuses what it cannot carry', () => {
  it('reports an empty chain as no head rather than as a zero-sequence one', async () => {
    await database.revertMigrations();
    await database.applyMigrations();
    expect(await readChainHead(database.pool)).toBeNull();
    expect(await readChainPage(database.pool, 1, 10)).toEqual([]);
  });

  /**
   * `chain_seq` is `bigint`. Beyond 2^53 a JavaScript `number` silently
   * rounds, and a verifier comparing two rounded sequences would report
   * distinct records as the same link. Refused rather than rounded.
   *
   * Planted for real, as the append-only trigger allows nothing else: inside
   * a transaction that is rolled back, with the trigger disabled, and read
   * back on the same client so the uncommitted row is visible.
   */
  it('refuses a chain_seq past the safe integer range instead of rounding it', async () => {
    await insertAuditRecord();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE platform.audit_record DISABLE TRIGGER audit_record_append_only`);
      await client.query(`UPDATE platform.audit_record SET chain_seq = 9007199254740993`);
      await expect(readChainHead(client)).rejects.toThrow(/exceeds the safe integer range/u);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
