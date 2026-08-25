import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectValue } from '../../../../testing/expect-result.js';
import type { ItemFingerprintRecord } from '../../domain/repository-ports.js';
import { PostgresFingerprintRepository } from './fingerprint.repository.js';

let database: TestDatabase;
let repository: PostgresFingerprintRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresFingerprintRepository(database.pool);
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

const SUBJECT = 'physics';

/** Inserts an item + item_version directly — the fingerprint's FK target. */
async function seedItemVersion(): Promise<{ itemId: string; itemVersionId: string }> {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  await database.pool.query(`INSERT INTO content.item (item_id, item_type) VALUES ($1, 'SINGLE_CORRECT_MCQ')`, [
    itemId,
  ]);
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
    [itemVersionId, itemId, freshUuid()],
  );
  return { itemId, itemVersionId };
}

function record(overrides: Partial<ItemFingerprintRecord> & { itemId: string; itemVersionId: string }): ItemFingerprintRecord {
  return {
    subject: SUBJECT,
    exactHash: `exact-${freshUuid()}`,
    skeletonHash: `skeleton-${freshUuid()}`,
    normalizedText: 'a block slides down a frictionless ramp',
    computedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
  };
}

describe('save / findByExactHash / findBySkeletonHash (M4-20)', () => {
  it('round trips a fingerprint', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    const fp = record({ itemId, itemVersionId });
    expectValue(await repository.save(fp));

    const byExact = expectValue(await repository.findByExactHash(SUBJECT, fp.exactHash));
    expect(byExact).toHaveLength(1);
    expect(byExact[0]).toMatchObject({ itemVersionId, exactHash: fp.exactHash });

    const bySkeleton = expectValue(await repository.findBySkeletonHash(SUBJECT, fp.skeletonHash));
    expect(bySkeleton).toHaveLength(1);
    expect(bySkeleton[0]).toMatchObject({ itemVersionId, skeletonHash: fp.skeletonHash });
  });

  it('upserts on a second save for the same item version', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    const first = record({ itemId, itemVersionId, exactHash: 'exact-v1' });
    expectValue(await repository.save(first));
    const second = record({ itemId, itemVersionId, exactHash: 'exact-v2' });
    expectValue(await repository.save(second));

    expect(expectValue(await repository.findByExactHash(SUBJECT, 'exact-v1'))).toEqual([]);
    expect(expectValue(await repository.findByExactHash(SUBJECT, 'exact-v2'))).toHaveLength(1);
  });

  it('finds nothing for a hash nobody recorded', async () => {
    expect(expectValue(await repository.findByExactHash(SUBJECT, 'never-recorded'))).toEqual([]);
    expect(expectValue(await repository.findBySkeletonHash(SUBJECT, 'never-recorded'))).toEqual([]);
  });
});

describe('findByItemVersionId (M4-32) — the "is there one already" check the claimed-item read makes', () => {
  it('finds the one record for this item version', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    const fp = record({ itemId, itemVersionId });
    expectValue(await repository.save(fp));

    const found = expectValue(await repository.findByItemVersionId(itemVersionId));
    expect(found).toMatchObject({ itemVersionId, exactHash: fp.exactHash });
  });

  it('is undefined, not an error, for an item version with no fingerprint yet', async () => {
    const { itemVersionId } = await seedItemVersion();
    expect(expectValue(await repository.findByItemVersionId(itemVersionId))).toBeUndefined();
  });

  it('reports a write it cannot make, rather than throwing', async () => {
    const refused = await repository.save(
      record({ itemId: freshUuid(), itemVersionId: freshUuid() }), // no item_version row exists — FK violation
    );
    expect(refused.ok).toBe(false);
  });
});

describe('findSimilarCandidates — retrieval and ranking only (M4-20)', () => {
  it('ranks the closer text higher, scoped to subject', async () => {
    const subject = `ranking-${freshUuid()}`;
    const target = 'a block slides down a frictionless ramp';
    const close = await seedItemVersion();
    expectValue(
      await repository.save(
        record({ ...close, subject, normalizedText: 'a block slides down a frictionless ramp incline' }),
      ),
    );
    const far = await seedItemVersion();
    expectValue(
      await repository.save(record({ ...far, subject, normalizedText: 'a capacitor charges through a resistor' })),
    );
    const otherSubject = await seedItemVersion();
    expectValue(
      await repository.save(record({ ...otherSubject, subject: 'chemistry', normalizedText: target })),
    );

    const ranked = expectValue(await repository.findSimilarCandidates(subject, target, 5));
    expect(ranked[0]!.fingerprint.itemVersionId).toBe(close.itemVersionId);
    expect(ranked[0]!.similarity).toBeGreaterThan(0.5);
    expect(ranked.map((r) => r.fingerprint.itemVersionId)).not.toContain(otherSubject.itemVersionId);
    // Wildly dissimilar text is exactly what the narrowing threshold exists
    // to drop — asserting its absence, not a similarity comparison, is what
    // that low-similarity floor actually guarantees.
    expect(ranked.map((r) => r.fingerprint.itemVersionId)).not.toContain(far.itemVersionId);
  });

  it('caps at the supplied limit', async () => {
    const subject = `cap-${freshUuid()}`;
    for (let i = 0; i < 4; i += 1) {
      const seeded = await seedItemVersion();
      // eslint-disable-next-line no-await-in-loop
      expectValue(await repository.save(record({ ...seeded, subject, normalizedText: `variant ${i} of a ramp problem` })));
    }
    const ranked = expectValue(await repository.findSimilarCandidates(subject, 'a ramp problem', 2));
    expect(ranked).toHaveLength(2);
  });

  it('returns nothing for a subject with no fingerprints', async () => {
    const ranked = expectValue(await repository.findSimilarCandidates(`empty-${freshUuid()}`, 'anything', 5));
    expect(ranked).toEqual([]);
  });
});

describe('the exact/skeleton lookups never consult the trigram index (M4-20)', () => {
  it('still answers correctly with pg_trgm uninstalled', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    const fp = record({ itemId, itemVersionId });
    expectValue(await repository.save(fp));

    await database.pool.query('DROP EXTENSION IF EXISTS pg_trgm CASCADE');
    try {
      const byExact = expectValue(await repository.findByExactHash(SUBJECT, fp.exactHash));
      expect(byExact[0]?.itemVersionId).toBe(itemVersionId);
      const bySkeleton = expectValue(await repository.findBySkeletonHash(SUBJECT, fp.skeletonHash));
      expect(bySkeleton[0]?.itemVersionId).toBe(itemVersionId);
    } finally {
      // Restores what the migration's up path installs — the next spec file's
      // own revert/apply cycle would also rebuild this, but leaving the
      // extension absent for the remainder of this file's tests is needless.
      await database.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await database.pool.query(
        `CREATE INDEX IF NOT EXISTS item_fingerprint_normalized_text_trgm_idx
           ON content.item_fingerprint USING gin (normalized_text gin_trgm_ops)`,
      );
    }
  });
});

describe('the fallback path returns identical results to the indexed path (M4-20)', () => {
  it('findSimilarCandidates agrees before and after the extension is dropped', async () => {
    const subject = `fallback-${freshUuid()}`;
    const target = 'a projectile is launched at an angle above the horizontal';
    const seeded: string[] = [];
    for (const text of [
      'a projectile is launched at an angle above the horizontal',
      'a projectile launched at an angle to the horizontal',
      'a wire carries a steady current through a magnetic field',
    ]) {
      const version = await seedItemVersion();
      // eslint-disable-next-line no-await-in-loop
      expectValue(await repository.save(record({ ...version, subject, normalizedText: text })));
      seeded.push(version.itemVersionId);
    }

    const indexed = expectValue(await repository.findSimilarCandidates(subject, target, 2));

    await database.pool.query('DROP EXTENSION IF EXISTS pg_trgm CASCADE');
    try {
      const fallback = expectValue(await repository.findSimilarCandidates(subject, target, 2));
      expect(fallback.map((r) => [r.fingerprint.itemVersionId, r.similarity])).toEqual(
        indexed.map((r) => [r.fingerprint.itemVersionId, r.similarity]),
      );
    } finally {
      await database.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await database.pool.query(
        `CREATE INDEX IF NOT EXISTS item_fingerprint_normalized_text_trgm_idx
           ON content.item_fingerprint USING gin (normalized_text gin_trgm_ops)`,
      );
    }
  });
});

describe('an unexpected persistence fault (M4-20)', () => {
  it('is reported as PERSISTENCE_REJECTED, not thrown', async () => {
    const brokenPool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/nonexistent', max: 1 });
    const broken = new PostgresFingerprintRepository(brokenPool);
    try {
      const refused = await broken.findSimilarCandidates(SUBJECT, 'anything', 5);
      expect(refused.ok).toBe(false);
    } finally {
      await brokenPool.end();
    }
  });
});
