import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import { readChainHead } from '../platform/persistence/audit-chain.js';
import { verifyAnchor, verifyChain } from '../platform/persistence/audit-chain-verify.js';
import { findAnchor, sealDay, signAnchor } from '../platform/persistence/audit-anchor.js';

/**
 * **F41** — SECURITY-ARCHITECTURE registers it as *"audit hash chain verifies
 * over the last 24 hours"*. This is that gate, plus the four tamper classes
 * M4-25 requires, each planted **for real**.
 *
 * "For real" means what it meant when F7/F40 first fired against a real role
 * (M0-24): as superuser, inside a transaction that is rolled back, with the
 * append-only trigger disabled for the length of the test. A tamper simulated
 * by handing the verifier a doctored object would prove only that the
 * verifier compares two buffers. These prove it detects a database whose rows
 * have actually been changed underneath it.
 *
 * Every tamper is read back **on the same client that wrote it**, because an
 * uncommitted row is visible nowhere else — which is also why the read path
 * takes a `Queryable` rather than a `Pool`.
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
  return `00000000-0000-4000-e000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const ANCHOR_KEY = 'an-f41-anchor-key-of-32-plus-bytes';

async function insertAuditRecord(occurredAt?: string): Promise<void> {
  await database.pool.query(
    `INSERT INTO platform.audit_record
       (audit_record_id, principal_kind, principal_id, action, target_context, target_type,
        target_id, correlation_id, occurred_at)
     VALUES ($1, 'human', $2, 'PublishItemVersion', 'content', 'Item', $3, 'c', $4::timestamptz)`,
    [freshUuid(), freshUuid(), freshUuid(), occurredAt ?? new Date().toISOString().replace('Z', '000Z')],
  );
}

/** A fresh chain, so sequence numbers in each test mean what they say. */
async function freshChain(records: number): Promise<void> {
  await database.revertMigrations();
  await database.applyMigrations();
  for (let i = 0; i < records; i += 1) await insertAuditRecord();
}

/**
 * Plants a tamper the only way the database permits — superuser, append-only
 * trigger off, inside a transaction that is always rolled back — and runs the
 * assertion against the same client, where the uncommitted rows are visible.
 */
async function withPlantedTamper(plant: (client: PoolClient) => Promise<void>, assert: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE platform.audit_record DISABLE TRIGGER audit_record_append_only`);
    await plant(client);
    await assert(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('a clean chain verifies', () => {
  it('verifies end to end over a non-zero record count', async () => {
    await freshChain(5);
    const head = await readChainHead(database.pool);
    const result = await verifyChain(database.pool, 1, head!.chainSeq);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recordCount).toBe(5);
    expect(result.firstSeq).toBe(1);
    expect(result.lastSeq).toBe(5);
  });

  it('verifies a bounded window without reading the whole chain', async () => {
    await freshChain(12);
    const result = await verifyChain(database.pool, 4, 8);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Five links, checked against a predecessor it read but did not verify.
    expect(result.recordCount).toBe(5);
    expect(result.firstSeq).toBe(4);
    expect(result.lastSeq).toBe(8);
  });

  it('reports an empty window as ok over zero records, which the F41 gate then refuses', async () => {
    await freshChain(3);
    const result = await verifyChain(database.pool, 900, 999);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Vacuously true — which is exactly why "ok" alone is not the gate.
    expect(result.recordCount).toBe(0);
  });
});

describe('tamper class 1 — a mutated field', () => {
  it('is detected at the record whose hash no longer matches its content', async () => {
    await freshChain(5);
    await withPlantedTamper(
      async (client) => {
        await client.query(`UPDATE platform.audit_record SET action = 'ForgedAction' WHERE chain_seq = 3`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 5);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(3);
        expect(result.reason).toBe('record_hash_mismatch');
      },
    );
  });

  it('is detected when a NULL is swapped for an empty string, not only on a visible edit', async () => {
    await freshChain(4);
    await withPlantedTamper(
      async (client) => {
        // justification is NULL on these rows; '' is the value a naive
        // canonicalizer would serialize identically.
        await client.query(`UPDATE platform.audit_record SET justification = '' WHERE chain_seq = 2`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 4);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(2);
        expect(result.reason).toBe('record_hash_mismatch');
      },
    );
  });

  it('is detected on a microsecond-only change to occurred_at', async () => {
    await freshChain(3);
    await withPlantedTamper(
      async (client) => {
        await client.query(
          `UPDATE platform.audit_record SET occurred_at = occurred_at + interval '1 microsecond' WHERE chain_seq = 2`,
        );
      },
      async (client) => {
        const result = await verifyChain(client, 1, 3);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(2);
        expect(result.reason).toBe('record_hash_mismatch');
      },
    );
  });
});

describe('tamper class 2 — a deleted link', () => {
  it('is detected as a sequence gap at the record after the hole', async () => {
    await freshChain(6);
    await withPlantedTamper(
      async (client) => {
        await client.query(`DELETE FROM platform.audit_record WHERE chain_seq = 4`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 6);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(5);
        expect(result.reason).toBe('sequence_gap');
        expect(result.detail).toContain('3');
      },
    );
  });

  it('is detected even when the attacker renumbers to close the gap', async () => {
    await freshChain(6);
    await withPlantedTamper(
      async (client) => {
        await client.query(`DELETE FROM platform.audit_record WHERE chain_seq = 4`);
        await client.query(`UPDATE platform.audit_record SET chain_seq = chain_seq - 1 WHERE chain_seq > 4`);
      },
      async (client) => {
        // No gap remains, but record 4 is now a row whose prev_hash names a
        // predecessor that is no longer at 3.
        const result = await verifyChain(client, 1, 5);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(4);
        expect(result.reason).toBe('prev_hash_mismatch');
      },
    );
  });
});

describe('tamper class 3 — two records swapped', () => {
  it('is detected at the first of the two', async () => {
    await freshChain(6);
    await withPlantedTamper(
      async (client) => {
        // Exchange the semantic content of 3 and 4, leaving the chain columns
        // where they are — the swap an attacker would attempt to reorder history.
        await client.query(`
          WITH a AS (SELECT action, target_id, correlation_id, occurred_at, principal_id
                       FROM platform.audit_record WHERE chain_seq = 3),
               b AS (SELECT action, target_id, correlation_id, occurred_at, principal_id
                       FROM platform.audit_record WHERE chain_seq = 4)
          UPDATE platform.audit_record r
             SET action = CASE WHEN r.chain_seq = 3 THEN (SELECT action FROM b) ELSE (SELECT action FROM a) END,
                 target_id = CASE WHEN r.chain_seq = 3 THEN (SELECT target_id FROM b) ELSE (SELECT target_id FROM a) END,
                 correlation_id = CASE WHEN r.chain_seq = 3 THEN (SELECT correlation_id FROM b) ELSE (SELECT correlation_id FROM a) END,
                 occurred_at = CASE WHEN r.chain_seq = 3 THEN (SELECT occurred_at FROM b) ELSE (SELECT occurred_at FROM a) END,
                 principal_id = CASE WHEN r.chain_seq = 3 THEN (SELECT principal_id FROM b) ELSE (SELECT principal_id FROM a) END
           WHERE r.chain_seq IN (3, 4)`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 6);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(3);
        expect(result.reason).toBe('record_hash_mismatch');
      },
    );
  });

  it('is detected when whole rows exchange their sequence numbers', async () => {
    await freshChain(6);
    await withPlantedTamper(
      async (client) => {
        await client.query(`UPDATE platform.audit_record SET chain_seq = 99 WHERE chain_seq = 3`);
        await client.query(`UPDATE platform.audit_record SET chain_seq = 3 WHERE chain_seq = 4`);
        await client.query(`UPDATE platform.audit_record SET chain_seq = 4 WHERE chain_seq = 99`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 6);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(3);
        // The row now at 3 carries the prev_hash it had at 4.
        expect(result.reason).toBe('prev_hash_mismatch');
      },
    );
  });
});

describe('tamper class 4 — a forged tail appended after a sealed anchor', () => {
  /**
   * The appended records chain *correctly* — the trigger sees to that — so
   * `verifyChain` is content and only the anchor notices. This is the case
   * that shows why the two checks are separate, and the one that shows what
   * the anchor is actually worth: the attacker cannot re-sign the day without
   * `auditAnchorKey`.
   */
  const DAY = '2026-11-05';

  async function seedAnchoredDay(): Promise<void> {
    await freshChain(0);
    await insertAuditRecord(`${DAY}T09:00:00.000000Z`);
    await insertAuditRecord(`${DAY}T10:00:00.000000Z`);
    await sealDay(database.pool, ANCHOR_KEY, DAY, `${DAY}T23:59:59.000000Z`);
  }

  it('leaves the links themselves verifying — which is the point', async () => {
    await seedAnchoredDay();
    await insertAuditRecord(`${DAY}T11:00:00.000000Z`);

    const head = await readChainHead(database.pool);
    const links = await verifyChain(database.pool, 1, head!.chainSeq);
    expect(links.ok).toBe(true);
  });

  it('is detected by the anchor, whose sealed range no longer matches the day', async () => {
    await seedAnchoredDay();
    const anchor = (await findAnchor(database.pool, DAY))!;
    expect((await verifyAnchor(database.pool, ANCHOR_KEY, anchor)).ok).toBe(true);

    await insertAuditRecord(`${DAY}T11:00:00.000000Z`);

    const result = await verifyAnchor(database.pool, ANCHOR_KEY, anchor);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('range_mismatch');
  });

  it('cannot be laundered by re-signing without the key', async () => {
    await seedAnchoredDay();
    const anchor = (await findAnchor(database.pool, DAY))!;
    await insertAuditRecord(`${DAY}T11:00:00.000000Z`);

    const head = await readChainHead(database.pool);
    // The attacker forges an anchor covering the extended day — and signs it
    // with a key they do not have.
    const forged = {
      ...anchor,
      lastSeq: head!.chainSeq,
      recordCount: anchor.recordCount + 1,
      headHash: head!.recordHash,
    };
    const wrongKey = 'the-attackers-own-32-plus-byte-key!!';
    const reSigned = { ...forged, signature: signAnchor(wrongKey, forged) };

    const result = await verifyAnchor(database.pool, ANCHOR_KEY, reSigned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_mismatch');
  });

  it('detects a mutated head hash independently of the link check', async () => {
    await seedAnchoredDay();
    const anchor = (await findAnchor(database.pool, DAY))!;
    const tampered = { ...anchor, headHash: Buffer.alloc(32, 0x7f) };
    // Re-signed under the *real* key, so only the head comparison can catch it —
    // the case where the key itself has leaked, which ADR-0020 states is beyond
    // what the anchor defends.
    const reSigned = { ...tampered, signature: signAnchor(ANCHOR_KEY, tampered) };

    const result = await verifyAnchor(database.pool, ANCHOR_KEY, reSigned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('head_hash_mismatch');
  });

  it('detects a record_count that disagrees with the day, at the same range', async () => {
    await seedAnchoredDay();
    const anchor = (await findAnchor(database.pool, DAY))!;
    const tampered = { ...anchor, recordCount: anchor.recordCount + 5 };
    const reSigned = { ...tampered, signature: signAnchor(ANCHOR_KEY, tampered) };

    const result = await verifyAnchor(database.pool, ANCHOR_KEY, reSigned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('record_count_mismatch');
  });
});

describe('sealDay refuses to seal a chain that does not verify (M4-34)', () => {
  /**
   * `sealDay` opens its own connection (`pool.connect()`), so unlike
   * `verifyChain`'s own tamper tests above, the tamper here must be a real,
   * committed write — a rolled-back one, visible only on the client that
   * wrote it, would be invisible to `sealDay`'s own connection. Every other
   * test in this file resets the whole chain with `freshChain` before it
   * runs, which is what makes a genuinely committed tamper here safe to
   * leave behind.
   */
  it('reports the divergent seq and reason rather than sealing over it, and seals nothing', async () => {
    const DAY = '2026-11-06';
    await freshChain(0);
    await insertAuditRecord(`${DAY}T09:00:00.000000Z`);
    await insertAuditRecord(`${DAY}T10:00:00.000000Z`);
    await insertAuditRecord(`${DAY}T11:00:00.000000Z`);

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE platform.audit_record DISABLE TRIGGER audit_record_append_only`);
      await client.query(
        `UPDATE platform.audit_record SET action = 'ForgedAction' WHERE occurred_at = $1::timestamptz`,
        [`${DAY}T10:00:00.000000Z`],
      );
      await client.query(`ALTER TABLE platform.audit_record ENABLE TRIGGER audit_record_append_only`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const outcome = await sealDay(database.pool, ANCHOR_KEY, DAY, `${DAY}T23:59:59.000000Z`);
    expect(outcome.kind).toBe('verification_failed');
    if (outcome.kind !== 'verification_failed') return;
    expect(outcome.firstDivergentSeq).toBe(2);
    expect(outcome.reason).toBe('record_hash_mismatch');

    expect(await findAnchor(database.pool, DAY)).toBeNull();
  });

  it('seals normally once the chain verifies', async () => {
    const DAY = '2026-11-07';
    await freshChain(0);
    await insertAuditRecord(`${DAY}T09:00:00.000000Z`);

    const outcome = await sealDay(database.pool, ANCHOR_KEY, DAY, `${DAY}T23:59:59.000000Z`);
    expect(outcome.kind).toBe('sealed');
  });
});

describe('F41 — the audit hash chain verifies over the last 24 hours', () => {
  /**
   * **The gate as registered, plus the assertion that keeps it honest.** A
   * chain that verifies over zero records is B1's failure mode wearing new
   * clothes: green, and about nothing. The non-zero count is not decoration —
   * it is half the gate.
   */
  it('verifies, and scans a non-zero record count', async () => {
    await freshChain(0);
    const now = new Date();
    for (let i = 0; i < 4; i += 1) {
      const at = new Date(now.getTime() - i * 60 * 60 * 1000);
      await insertAuditRecord(`${at.toISOString().replace('Z', '')}000Z`);
    }

    const window = await database.pool.query<{ first: string | null; last: string | null }>(
      `SELECT min(chain_seq)::text AS first, max(chain_seq)::text AS last
         FROM platform.audit_record WHERE occurred_at >= now() - interval '24 hours'`,
    );
    const first = Number(window.rows[0]!.first);
    const last = Number(window.rows[0]!.last);

    const result = await verifyChain(database.pool, first, last);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both halves. Either alone is a gate that cannot fail.
    expect(result.recordCount).toBeGreaterThan(0);
    expect(result.recordCount).toBe(4);
  });

  /**
   * The vacuity assertion, proven able to fail. Over an empty window
   * `verifyChain` returns `ok` — correctly, there is nothing to disagree with —
   * so a gate written as `expect(result.ok).toBe(true)` alone would pass on a
   * database with no audit records at all.
   */
  it('is red on an empty window, which is what the non-zero count is for', async () => {
    await freshChain(0);
    const result = await verifyChain(database.pool, 1, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recordCount).toBe(0);
    // The gate's own assertion, inverted: this is the state it must refuse.
    expect(() => expect(result.recordCount).toBeGreaterThan(0)).toThrow();
  });
});

describe('verification is bounded and streams', () => {
  /**
   * The scan pulls fixed-size pages and continues past the last row it
   * consumed. With the page size forced below the record count, a verifier
   * that read one page and stopped — or that re-read the same page forever —
   * fails here rather than on the day the audit log outgrows memory.
   */
  it('traverses every link across multiple pages', async () => {
    await freshChain(7);
    const result = await verifyChain(database.pool, 1, 7, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recordCount).toBe(7);
    expect(result.lastSeq).toBe(7);
  });

  it('finds a tamper on a later page, not only on the first', async () => {
    await freshChain(7);
    await withPlantedTamper(
      async (client) => {
        await client.query(`UPDATE platform.audit_record SET action = 'Forged' WHERE chain_seq = 6`);
      },
      async (client) => {
        const result = await verifyChain(client, 1, 7, 2);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(6);
      },
    );
  });
});

describe('the first link of the chain is checked against genesis, not skipped', () => {
  it('detects a genesis row whose prev_hash is not the all-zero predecessor', async () => {
    await freshChain(3);
    await withPlantedTamper(
      async (client) => {
        await client.query(
          `UPDATE platform.audit_record SET prev_hash = decode(repeat('ab', 32), 'hex') WHERE chain_seq = 1`,
        );
      },
      async (client) => {
        const result = await verifyChain(client, 1, 3);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.firstDivergentSeq).toBe(1);
        expect(result.reason).toBe('prev_hash_mismatch');
        expect(result.detail).toContain('genesis');
      },
    );
  });
});
