import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { loadConfig } from '../config/config.js';
import {
  AUDIT_ANCHOR_SEALED_EVENT,
  canonicalizeAnchor,
  findAnchor,
  sealDay,
  signAnchor,
  verifyAnchorSignature,
  type AuditAnchor,
} from './audit-anchor.js';

/**
 * M4-24. What the anchor claims, and what it does not.
 *
 * The limit is in the module header and in ADR-0020: a key on the machine
 * that holds the database bounds the attacker to one holding both, and that
 * is not notarization. These tests prove the mechanism does what it says —
 * they cannot, and do not, prove more than the mechanism is worth.
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

const KEY = 'a-test-anchor-key-of-at-least-32-bytes';
const SEALED_AT = '2026-08-21T00:05:00.000000Z';

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-d000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

async function insertAuditRecordOn(day: string, hour = 9): Promise<void> {
  await database.pool.query(
    `INSERT INTO platform.audit_record
       (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
        target_id, correlation_id, occurred_at)
     VALUES ($1, 'human', $2, 'PublishItemVersion', 'content', 'Item', $3, 'c', $4::timestamptz)`,
    [freshUuid(), freshUuid(), freshUuid(), `${day}T${String(hour).padStart(2, '0')}:00:00.000000Z`],
  );
}

/** A day nothing else in this file has touched, so counts are unambiguous. */
let dayCounter = 0;
function freshDay(): string {
  dayCounter += 1;
  return `2026-09-${String(dayCounter).padStart(2, '0')}`;
}

describe('sealing a day', () => {
  it('writes one anchor covering the day’s sequence range and head', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day, 9);
    await insertAuditRecordOn(day, 10);

    const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
    expect(outcome.kind).toBe('sealed');
    if (outcome.kind !== 'sealed') return;

    const { anchor } = outcome;
    expect(anchor.day).toBe(day);
    expect(anchor.recordCount).toBe(2);
    expect(anchor.lastSeq).toBeGreaterThanOrEqual(anchor.firstSeq);
    expect(anchor.headHash).toHaveLength(32);

    // The head really is the chain's record at last_seq, not merely 32 bytes.
    const head = await database.pool.query<{ record_hash: Buffer }>(
      `SELECT record_hash FROM platform.audit_record WHERE chain_seq = $1`,
      [anchor.lastSeq],
    );
    expect(head.rows[0]!.record_hash.equals(anchor.headHash)).toBe(true);
  });

  it('refuses a day with no records rather than signing a vacuous claim', async () => {
    const outcome = await sealDay(database.pool, KEY, '2026-12-25', SEALED_AT);
    expect(outcome.kind).toBe('no_records');
    expect(await findAnchor(database.pool, '2026-12-25')).toBeNull();
  });

  it('covers only its own day, not the ones on either side', async () => {
    const day = freshDay();
    await insertAuditRecordOn('2026-09-20', 9);
    await insertAuditRecordOn(day, 9);
    await insertAuditRecordOn('2026-09-22', 9);

    const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
    expect(outcome.kind).toBe('sealed');
    if (outcome.kind !== 'sealed') return;
    expect(outcome.anchor.recordCount).toBe(1);
  });
});

describe('sealing is idempotent — never a second row, never a re-signature', () => {
  it('returns the existing anchor unchanged on a second seal', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);

    const first = await sealDay(database.pool, KEY, day, SEALED_AT);
    expect(first.kind).toBe('sealed');
    if (first.kind !== 'sealed') return;

    // A later instant, which would produce a different signature if the day
    // were re-signed. It must not be.
    const second = await sealDay(database.pool, KEY, day, '2026-08-22T11:11:11.111111Z');
    expect(second.kind).toBe('already_sealed');
    if (second.kind !== 'already_sealed') return;

    expect(second.anchor.anchorId).toBe(first.anchor.anchorId);
    expect(second.anchor.sealedAt).toBe(first.anchor.sealedAt);
    expect(second.anchor.signature.equals(first.anchor.signature)).toBe(true);
  });

  it('leaves exactly one row and one outbox event after two seals', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    await sealDay(database.pool, KEY, day, SEALED_AT);
    await sealDay(database.pool, KEY, day, SEALED_AT);

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.audit_anchor WHERE day = $1::date`,
      [day],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);

    const events = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_message
        WHERE event_type = $1 AND correlation_id = $2`,
      [AUDIT_ANCHOR_SEALED_EVENT, `audit-anchor-${day}`],
    );
    expect(Number(events.rows[0]!.count)).toBe(1);
  });

  it('two sealers racing the same day resolve to one anchor and one signature', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);

    const [a, b] = await Promise.all([
      sealDay(database.pool, KEY, day, SEALED_AT),
      sealDay(database.pool, KEY, day, '2026-08-23T22:22:22.222222Z'),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['already_sealed', 'sealed']);

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.audit_anchor WHERE day = $1::date`,
      [day],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it('the database refuses a second row for the same day even by raw SQL', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    const sealed = await sealDay(database.pool, KEY, day, SEALED_AT);
    if (sealed.kind !== 'sealed') throw new Error('expected a seal');

    let message = '';
    try {
      await database.pool.query(
        `INSERT INTO platform.audit_anchor (day, first_seq, last_seq, head_hash, record_count, sealed_at, signature)
         VALUES ($1::date, 1, 1, $2, 1, now(), $2)`,
        [day, Buffer.alloc(32, 9)],
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/audit_anchor_day_key|duplicate key/u);
  });
});

describe('the signature', () => {
  it('verifies against the key it was signed with', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
    if (outcome.kind !== 'sealed') throw new Error('expected a seal');

    expect(verifyAnchorSignature(KEY, outcome.anchor)).toBe(true);
  });

  it('fails under a different key — the anchor is not self-certifying', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
    if (outcome.kind !== 'sealed') throw new Error('expected a seal');

    expect(verifyAnchorSignature('a-different-anchor-key-of-32-plus-bytes', outcome.anchor)).toBe(false);
  });

  /**
   * Per field, not once on a representative anchor: an anchor whose
   * `record_count` could be edited without breaking the signature would let a
   * rewrite hide behind a count that still looked plausible.
   */
  const MUTATIONS: Readonly<Record<string, (a: AuditAnchor) => AuditAnchor>> = {
    day: (a) => ({ ...a, day: '2026-01-01' }),
    firstSeq: (a) => ({ ...a, firstSeq: a.firstSeq + 1 }),
    lastSeq: (a) => ({ ...a, lastSeq: a.lastSeq + 1 }),
    headHash: (a) => ({ ...a, headHash: Buffer.alloc(32, 0xab) }),
    recordCount: (a) => ({ ...a, recordCount: a.recordCount + 1 }),
    sealedAt: (a) => ({ ...a, sealedAt: '2030-01-01T00:00:00.000000Z' }),
  };

  for (const [field, mutate] of Object.entries(MUTATIONS)) {
    it(`fails when ${field} is mutated`, async () => {
      const day = freshDay();
      await insertAuditRecordOn(day);
      const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
      if (outcome.kind !== 'sealed') throw new Error('expected a seal');

      const tampered = mutate(outcome.anchor);
      expect(canonicalizeAnchor(tampered).equals(canonicalizeAnchor(outcome.anchor))).toBe(false);
      expect(verifyAnchorSignature(KEY, tampered)).toBe(false);
    });
  }

  it('names every signed field, so the loop above is not silently short', () => {
    // anchorId is deliberately unsigned — a surrogate key carrying no claim;
    // `day` is the identity and is signed. Everything else is covered.
    expect(Object.keys(MUTATIONS).sort()).toEqual(
      ['day', 'firstSeq', 'headHash', 'lastSeq', 'recordCount', 'sealedAt'].sort(),
    );
  });

  it('is length-prefixed, so a range cannot be re-split without changing the bytes', () => {
    const base = {
      day: '2026-09-01',
      headHash: Buffer.alloc(32, 1),
      recordCount: 5,
      sealedAt: SEALED_AT,
    };
    const a = canonicalizeAnchor({ ...base, firstSeq: 1, lastSeq: 23 });
    const b = canonicalizeAnchor({ ...base, firstSeq: 12, lastSeq: 3 });
    expect(a.equals(b)).toBe(false);
  });

  it('is stable — signing the same anchor twice produces the same bytes', () => {
    const unsigned = {
      day: '2026-09-01',
      firstSeq: 1,
      lastSeq: 9,
      headHash: Buffer.alloc(32, 3),
      recordCount: 9,
      sealedAt: SEALED_AT,
    };
    expect(signAnchor(KEY, unsigned).equals(signAnchor(KEY, unsigned))).toBe(true);
  });
});

describe('the AuditAnchorSealed event is written in the same transaction', () => {
  it('appears in the outbox alongside the anchor', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    const outcome = await sealDay(database.pool, KEY, day, SEALED_AT);
    if (outcome.kind !== 'sealed') throw new Error('expected a seal');

    const found = await database.pool.query<{
      aggregate_id: string;
      aggregate_type: string;
      payload: Record<string, unknown>;
      principal_kind: string;
    }>(
      `SELECT aggregate_id::text AS aggregate_id, aggregate_type, payload, principal_kind
         FROM platform.outbox_message WHERE event_type = $1 AND correlation_id = $2`,
      [AUDIT_ANCHOR_SEALED_EVENT, `audit-anchor-${day}`],
    );
    expect(found.rowCount).toBe(1);
    const row = found.rows[0]!;
    expect(row.aggregate_id).toBe(outcome.anchor.anchorId);
    expect(row.aggregate_type).toBe('AuditAnchor');
    expect(row.principal_kind).toBe('system');
    expect(row.payload['headHash']).toBe(outcome.anchor.headHash.toString('hex'));
    // The signature is not in the payload: the outbox drains to analytics
    // (P4/D17), and a witness needs the head, not the secret-derived seal.
    expect(row.payload['signature']).toBeUndefined();
  });

  /**
   * Rollback proof. The anchor insert and the outbox insert share one
   * transaction, so a failure after the anchor row must leave neither — the
   * alternative is an anchor a witness never hears about.
   */
  it('leaves neither the anchor nor the event when the transaction rolls back', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);

    // Break the outbox insert for the length of this test by pointing its
    // NOT NULL event_type at a check the row cannot satisfy.
    await database.pool.query(
      `ALTER TABLE platform.outbox_message ADD CONSTRAINT outbox_reject_anchor
         CHECK (event_type <> 'AuditAnchorSealed') NOT VALID`,
    );
    try {
      await expect(sealDay(database.pool, KEY, day, SEALED_AT)).rejects.toThrow();
    } finally {
      await database.pool.query(`ALTER TABLE platform.outbox_message DROP CONSTRAINT outbox_reject_anchor`);
    }

    expect(await findAnchor(database.pool, day)).toBeNull();
    const events = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_message WHERE correlation_id = $1`,
      [`audit-anchor-${day}`],
    );
    expect(Number(events.rows[0]!.count)).toBe(0);

    // And the day is still sealable afterwards — the rollback left no debris.
    expect((await sealDay(database.pool, KEY, day, SEALED_AT)).kind).toBe('sealed');
  });
});

describe('the anchor table is append-only, like every other platform table', () => {
  it('rejects an UPDATE', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    await sealDay(database.pool, KEY, day, SEALED_AT);
    await expect(
      database.pool.query(`UPDATE platform.audit_anchor SET record_count = 99 WHERE day = $1::date`, [day]),
    ).rejects.toThrow(/append_only/u);
  });

  it('rejects a DELETE', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);
    await sealDay(database.pool, KEY, day, SEALED_AT);
    await expect(
      database.pool.query(`DELETE FROM platform.audit_anchor WHERE day = $1::date`, [day]),
    ).rejects.toThrow(/append_only/u);
  });

  it('grants the app role SELECT and INSERT only', async () => {
    const found = await database.pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'audit_anchor' AND grantee = 'questionbank_app'`,
    );
    expect(found.rows.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });
});

describe('auditAnchorKey is a configuration key with no default (M4-24)', () => {
  const BASE = {
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/questionbank',
    AUTH_SIGNING_KEY: 'an-auth-signing-key-of-at-least-32-bytes',
    AUDIT_ANCHOR_KEY: 'an-audit-anchor-key-of-at-least-32-bytes',
  };

  it('loads when set', () => {
    const loaded = loadConfig(BASE);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.auditAnchorKey).toBe(BASE.AUDIT_ANCHOR_KEY);
  });

  it('is a config error naming the key when absent, with no value in the message', () => {
    const loaded = loadConfig({ ...BASE, AUDIT_ANCHOR_KEY: undefined });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.key).toBe('auditAnchorKey');
    expect(loaded.error.message).toContain('AUDIT_ANCHOR_KEY');
    expect(loaded.error.message).not.toContain(BASE.AUTH_SIGNING_KEY);
  });

  it('refuses a key under 32 bytes', () => {
    const loaded = loadConfig({ ...BASE, AUDIT_ANCHOR_KEY: 'too-short' });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.key).toBe('auditAnchorKey');
    expect(loaded.error.message).toContain('32 bytes');
    expect(loaded.error.message).not.toContain('too-short');
  });

  /**
   * ADR-0020's reason for a second key is that one compromise should not forge
   * both sessions and history. Two keys with the same value are one key
   * wearing two names, so config refuses rather than trusting convention.
   */
  it('refuses a key equal to authSigningKey', () => {
    const loaded = loadConfig({ ...BASE, AUDIT_ANCHOR_KEY: BASE.AUTH_SIGNING_KEY });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.key).toBe('auditAnchorKey');
    expect(loaded.error.message).toContain('must not equal AUTH_SIGNING_KEY');
    expect(loaded.error.message).not.toContain(BASE.AUTH_SIGNING_KEY);
  });
});

describe('sealDay refuses malformed arguments rather than storing them', () => {
  it('refuses a day that is not YYYY-MM-DD', async () => {
    await expect(sealDay(database.pool, KEY, '20-08-2026', SEALED_AT)).rejects.toThrow(
      /is not YYYY-MM-DD/u,
    );
  });

  /**
   * The same microsecond rule the chain enforces, for the same reason: a
   * millisecond `sealedAt` is a value the signature could not be reproduced
   * over after a round-trip through the database.
   */
  it('refuses a sealedAt that is not a six-digit UTC instant', async () => {
    await expect(sealDay(database.pool, KEY, '2026-10-01', '2026-10-01T00:00:00.000Z')).rejects.toThrow(
      /six fractional digits/u,
    );
  });
});

describe('the lost race is resolved by the database, deterministically', () => {
  /**
   * The `Promise.all` race above is real but timing-dependent — it usually
   * resolves on the cheap pre-flight read, never reaching the insert. This
   * forces the path that actually matters: a competing anchor that is written
   * but **not yet committed**, so the pre-flight read cannot see it and
   * `sealDay` proceeds all the way to its INSERT.
   *
   * A plain INSERT blocks there until the competitor commits, then raises
   * `unique_violation`. That is why the insert is not `ON CONFLICT DO
   * NOTHING`: `DO NOTHING` would skip the uncommitted row instead of waiting,
   * and the re-read that follows would find nothing at all.
   */
  it('waits for the in-flight winner, then returns it rather than re-signing', async () => {
    const day = freshDay();
    await insertAuditRecordOn(day);

    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO platform.audit_anchor (day, first_seq, last_seq, head_hash, record_count, sealed_at, signature)
         VALUES ($1::date, 1, 1, $2, 1, now(), $3)`,
        [day, Buffer.alloc(32, 4), Buffer.alloc(32, 5)],
      );

      // Starts, passes the pre-flight read (the row above is invisible), and
      // blocks on its own INSERT.
      const contender = sealDay(database.pool, KEY, day, SEALED_AT);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('COMMIT');

      const outcome = await contender;
      expect(outcome.kind).toBe('already_sealed');
      if (outcome.kind !== 'already_sealed') return;
      // The winner's signature, not one this call produced.
      expect(outcome.anchor.signature.equals(Buffer.alloc(32, 5))).toBe(true);
    } finally {
      holder.release();
    }

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.audit_anchor WHERE day = $1::date`,
      [day],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });
});
