import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed, derivedIdentifier, SEED_PRINCIPAL } from './index.js';
import { connectTestDatabase, type TestDatabase } from '../../apps/api/src/testing/database.js';

let database: TestDatabase;

async function count(table: string): Promise<number> {
  const result = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
});

afterAll(async () => {
  await database.close();
});

describe('pnpm seed', () => {
  it('loads and publishes both taxonomies and both profiles on a clean database', async () => {
    const summary = await seed(database.db);

    expect(summary.taxonomies.map((taxonomy) => taxonomy.file)).toEqual([
      'jee-main-2026.taxonomy.yaml',
      'neet-ug-2026.taxonomy.yaml',
    ]);
    expect(summary.profiles.map((profile) => profile.file)).toEqual([
      'jee-main-2026.profile.yaml',
      'neet-ug-2026.profile.yaml',
    ]);

    expect(await count('curriculum.taxonomy_version')).toBe(2);
    expect(await count('curriculum.exam')).toBe(2);
    expect(await count('curriculum.exam_profile_version')).toBe(2);
    expect(await count('curriculum.exam_section_spec')).toBe(6);
  }, 120_000);

  it('publishes everything it loads', async () => {
    await seed(database.db);

    const versions = await database.pool.query<{ state: string }>(
      `SELECT state FROM curriculum.taxonomy_version`,
    );
    const profiles = await database.pool.query<{ state: string; is_active: boolean }>(
      `SELECT state, is_active FROM curriculum.exam_profile_version`,
    );

    expect(versions.rows.every((row) => row.state === 'published')).toBe(true);
    expect(profiles.rows.every((row) => row.state === 'published' && row.is_active)).toBe(true);
  }, 120_000);

  it('attributes every publication to the seed principal', async () => {
    await seed(database.db);

    const rows = await database.pool.query<{ published_by_kind: string; published_by_id: string }>(
      `SELECT published_by_kind, published_by_id FROM curriculum.taxonomy_version
       UNION ALL
       SELECT published_by_kind, published_by_id FROM curriculum.exam_profile_version`,
    );

    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) {
      expect(row.published_by_kind).toBe('system');
      expect(row.published_by_id).toBe(SEED_PRINCIPAL.id);
    }
  }, 120_000);

  it('is idempotent: a second run changes nothing', async () => {
    await seed(database.db);
    const before = {
      versions: await count('curriculum.taxonomy_version'),
      concepts: await count('curriculum.concept_node'),
      profiles: await count('curriculum.exam_profile_version'),
      sections: await count('curriculum.exam_section_spec'),
    };

    const second = await seed(database.db);

    expect(second.taxonomies.every((taxonomy) => taxonomy.unchanged)).toBe(true);
    expect(second.profiles.every((profile) => profile.unchanged)).toBe(true);
    expect({
      versions: await count('curriculum.taxonomy_version'),
      concepts: await count('curriculum.concept_node'),
      profiles: await count('curriculum.exam_profile_version'),
      sections: await count('curriculum.exam_section_spec'),
    }).toEqual(before);
  }, 180_000);

  it('completes within the 60-second budget', async () => {
    const summary = await seed(database.db);

    expect(summary.durationMs).toBeLessThan(60_000);
  }, 120_000);

  it('produces a curriculum a developer can actually query', async () => {
    await seed(database.db);

    const jee = await database.pool.query<{ code: string; total_marks: string; item_count: number }>(
      `SELECT e.code, p.total_marks, sum(s.item_count)::int AS item_count
       FROM curriculum.exam e
       JOIN curriculum.exam_profile_version p ON p.exam_id = e.exam_id
       JOIN curriculum.exam_section_spec s ON s.profile_version_id = p.profile_version_id
       WHERE e.code = 'JEE_MAIN'
       GROUP BY e.code, p.total_marks`,
    );
    const neet = await database.pool.query<{ item_count: number }>(
      `SELECT sum(s.item_count)::int AS item_count
       FROM curriculum.exam e
       JOIN curriculum.exam_profile_version p ON p.exam_id = e.exam_id
       JOIN curriculum.exam_section_spec s ON s.profile_version_id = p.profile_version_id
       WHERE e.code = 'NEET_UG'`,
    );

    expect(Number(jee.rows[0]?.total_marks)).toBe(300);
    expect(jee.rows[0]?.item_count).toBe(75);
    expect(neet.rows[0]?.item_count).toBe(180);
  }, 120_000);

  it('derives stable identifiers', () => {
    expect(derivedIdentifier('exam', 'JEE_MAIN')).toBe(derivedIdentifier('exam', 'JEE_MAIN'));
    expect(derivedIdentifier('exam', 'JEE_MAIN')).not.toBe(derivedIdentifier('exam', 'NEET_UG'));
    expect(derivedIdentifier('exam', 'JEE_MAIN')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
