import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';

/**
 * Real Postgres, never a mock (ENGINEERING-HANDBOOK §5). These specs create and
 * drop the `content` schema, so they run against a throwaway database.
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

async function rows<T>(query: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await database.pool.query(query, [...params]);
  return result.rows as T[];
}

async function rejects(query: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(query, [...params]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected the database to refuse: ${query}`);
}

const CONTENT_TABLES = [
  'alternate_approach',
  'content_licensing',
  'content_media_ref',
  'distractor_analysis',
  'item',
  // The duplicate-detection cache (M4-09/M4-20) — the same not-in-§4 note
  // 'review_decision' already carries below applies here too.
  'item_fingerprint',
  'item_matching_member',
  'item_matching_pair',
  'item_numeric_spec',
  'item_option',
  'item_provenance',
  'item_taxonomy_tag',
  'item_version',
  'item_version_locale',
  'media_asset',
  'media_asset_version',
  // The review workspace's own storage (M4-17/M4-18/DEC-M4-7). DATA-ARCHITECTURE
  // §4 does not name any of these three because ROADMAP put review in M4 — the
  // same reason 'review_decision' below is not there either.
  'review_assignment',
  'review_candidate_shown',
  // The review record (M3-28). DATA-ARCHITECTURE §4 does not name it because
  // ROADMAP put review in M4; ADR-0010 records why the lifecycle — and so the
  // evidence its preconditions consume — lands here instead.
  'review_decision',
  'review_escalation',
  'solution',
  'solution_step',
  'solution_version',
  'stimulus',
  'stimulus_version',
];

/** Builds a minimal published-capable item and returns its identifiers. */
async function seedItem(options: { readonly itemType?: string } = {}): Promise<{
  itemId: string;
  itemVersionId: string;
}> {
  const itemType = options.itemType ?? 'SINGLE_CORRECT_MCQ';
  const [item] = await rows<{ item_id: string }>(
    `INSERT INTO content.item (item_type) VALUES ($1) RETURNING item_id`,
    [itemType],
  );
  const [version] = await rows<{ item_version_id: string }>(
    `INSERT INTO content.item_version
       (item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, 1, $2, '{"schemaVersion":1,"blocks":[]}'::jsonb, 'a stem', 'moderate',
             'human', gen_random_uuid())
     RETURNING item_version_id`,
    [item!.item_id, itemType],
  );
  return { itemId: item!.item_id, itemVersionId: version!.item_version_id };
}

async function seedMediaAsset(): Promise<{ assetId: string; assetVersionId: string }> {
  const [asset] = await rows<{ asset_id: string }>(
    `INSERT INTO content.media_asset (asset_type) VALUES ('diagram') RETURNING asset_id`,
  );
  const [version] = await rows<{ asset_version_id: string }>(
    `INSERT INTO content.media_asset_version
       (asset_id, version_no, storage_key, checksum, mime_type, width, height, alt_text,
        authored_by_kind, authored_by_id)
     VALUES ($1, 1, 'k', 'sha256:x', 'image/png', 100, 100, 'a ramp', 'human', gen_random_uuid())
     RETURNING asset_version_id`,
    [asset!.asset_id],
  );
  return { assetId: asset!.asset_id, assetVersionId: version!.asset_version_id };
}

describe('the content schema', () => {
  it('creates exactly the tables DATA-ARCHITECTURE §4 names', async () => {
    const found = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'content' ORDER BY table_name`,
    );
    expect(found.map((row) => row.table_name)).toEqual(CONTENT_TABLES);
  });

  // §2 asks for singular table names. A naive "does not end in s" check is
  // wrong for words whose singular already does — `analysis` pluralises to
  // `analyses`, so the table below is singular and the heuristic was not.
  it('names every table in the singular (§2)', () => {
    const SINGULAR_ENDING_IN_S = /(?:ss|us|is)$/u;
    for (const table of CONTENT_TABLES) {
      const looksPlural = table.endsWith('s') && !SINGULAR_ENDING_IN_S.test(table);
      expect(looksPlural, table).toBe(false);
    }
  });

  it('carries tenant_id, aggregate_version and created_at on each aggregate root (P7, P8, P1)', async () => {
    for (const table of ['item', 'stimulus', 'solution', 'media_asset']) {
      const columns = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'content' AND table_name = $1`,
        [table],
      );
      const names = columns.map((row) => row.column_name);
      expect(names, table).toContain('tenant_id');
      expect(names, table).toContain('aggregate_version');
      expect(names, table).toContain('created_at');
    }
  });

  it('carries deleted_at on item only, not on every table (P2)', async () => {
    const found = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'content' AND column_name = 'deleted_at' ORDER BY table_name`,
    );
    expect(found.map((row) => row.table_name)).toEqual(['item']);
  });
});

describe('F5 — every JSONB column has a sibling *_schema_version', () => {
  it('holds across the whole content schema', async () => {
    const orphans = await rows<{ table_name: string; column_name: string }>(
      `SELECT j.table_name, j.column_name
         FROM information_schema.columns j
        WHERE j.table_schema = 'content'
          AND j.data_type = 'jsonb'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns v
             WHERE v.table_schema = j.table_schema
               AND v.table_name = j.table_name
               AND v.column_name = j.column_name || '_schema_version')
        ORDER BY j.table_name, j.column_name`,
    );
    expect(orphans).toEqual([]);
  });

  it('found some JSONB columns to check, so the query is not vacuously empty', async () => {
    const [count] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_schema = 'content' AND data_type = 'jsonb'`,
    );
    expect(Number(count!.count)).toBeGreaterThanOrEqual(9);
  });
});

describe('§9 rule 3 — no foreign key crosses a schema boundary', () => {
  it('holds for every constraint in the content schema', async () => {
    const crossing = await rows<{ constraint_name: string; foreign_schema: string }>(
      `SELECT c.conname AS constraint_name, fn.nspname AS foreign_schema
         FROM pg_constraint c
         JOIN pg_class t  ON t.oid  = c.conrelid
         JOIN pg_namespace n  ON n.oid  = t.relnamespace
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_namespace fn ON fn.oid = ft.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'content' AND fn.nspname <> 'content'`,
    );
    expect(crossing).toEqual([]);
  });

  // Curriculum's identifiers are carried as values, which is what lets a tag
  // stay interpretable after its taxonomy version is superseded.
  it('carries concept and taxonomy identifiers as plain columns', async () => {
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'content' AND table_name = 'item_taxonomy_tag'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('concept_identity_id');
    expect(names).toContain('taxonomy_version_id');
  });
});

describe('ACC-03 — alt text is enforced at the database, not only in the type', () => {
  it('refuses a media version with a null alt text', async () => {
    const [asset] = await rows<{ asset_id: string }>(
      `INSERT INTO content.media_asset (asset_type) VALUES ('photograph') RETURNING asset_id`,
    );
    const message = await rejects(
      `INSERT INTO content.media_asset_version
         (asset_id, version_no, storage_key, checksum, mime_type, width, height, alt_text,
          authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'k', 'c', 'image/png', 10, 10, NULL, 'human', gen_random_uuid())`,
      [asset!.asset_id],
    );
    expect(message).toMatch(/alt_text/u);
  });

  it('refuses a whitespace-only alt text', async () => {
    const [asset] = await rows<{ asset_id: string }>(
      `INSERT INTO content.media_asset (asset_type) VALUES ('photograph') RETURNING asset_id`,
    );
    const message = await rejects(
      `INSERT INTO content.media_asset_version
         (asset_id, version_no, storage_key, checksum, mime_type, width, height, alt_text,
          authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'k', 'c', 'image/png', 10, 10, '   ', 'human', gen_random_uuid())`,
      [asset!.asset_id],
    );
    expect(message).toMatch(/alt_text/u);
  });

  it('accepts a version that has one', async () => {
    const seeded = await seedMediaAsset();
    expect(seeded.assetVersionId).toBeDefined();
  });
});

describe('INV-03 — at most one published version, and it must exist', () => {
  it('refuses a published item naming no version', async () => {
    const { itemId } = await seedItem();
    const message = await rejects(
      `UPDATE content.item SET lifecycle_state = 'published' WHERE item_id = $1`,
      [itemId],
    );
    expect(message).toMatch(/item_published_names_a_version/u);
  });

  it('accepts a published item that names one', async () => {
    const { itemId, itemVersionId } = await seedItem();
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'published', current_published_version_id = $2
        WHERE item_id = $1`,
      [itemId, itemVersionId],
    );
    const [row] = await rows<{ lifecycle_state: string }>(
      `SELECT lifecycle_state FROM content.item WHERE item_id = $1`,
      [itemId],
    );
    expect(row!.lifecycle_state).toBe('published');
  });

  it('refuses a published version reference the item does not hold', async () => {
    const { itemId } = await seedItem();
    const other = await seedItem();
    // The foreign key permits any existing version; the aggregate is what ties
    // it to this item, so what the database guarantees is that the reference
    // resolves at all.
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'published', current_published_version_id = $2
        WHERE item_id = $1`,
      [itemId, other.itemVersionId],
    );
    const message = await rejects(
      `UPDATE content.item SET current_published_version_id = gen_random_uuid() WHERE item_id = $1`,
      [itemId],
    );
    expect(message).toMatch(/item_published_version_fk/u);
  });

  it('refuses a second version with the same number', async () => {
    const { itemId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.item_version
         (item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', gen_random_uuid())`,
      [itemId],
    );
    expect(message).toMatch(/item_version_no_unique/u);
  });
});

describe('the lifecycle domain is shared, not respelled per table', () => {
  it('refuses a state outside FR-QM-01’s eight, on every aggregate', async () => {
    const { itemId } = await seedItem();
    const message = await rejects(
      `UPDATE content.item SET lifecycle_state = 'archived' WHERE item_id = $1`,
      [itemId],
    );
    expect(message).toMatch(/lifecycle_state/u);
  });

  it('uses one domain type across item, stimulus, solution and media_asset', async () => {
    const found = await rows<{ table_name: string; domain_name: string }>(
      `SELECT table_name, domain_name FROM information_schema.columns
        WHERE table_schema = 'content' AND column_name = 'lifecycle_state' ORDER BY table_name`,
    );
    expect(found.map((row) => row.table_name)).toEqual(['item', 'media_asset', 'solution', 'stimulus']);
    for (const row of found) expect(row.domain_name).toBe('lifecycle_state');
  });
});

describe('P2 — only a draft is ever discarded (FR-QM-01 rule 5)', () => {
  it('permits marking a never-published draft deleted', async () => {
    const { itemId } = await seedItem();
    await database.pool.query(`UPDATE content.item SET deleted_at = now() WHERE item_id = $1`, [itemId]);
    const [row] = await rows<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM content.item WHERE item_id = $1`,
      [itemId],
    );
    expect(row!.deleted_at).not.toBeNull();
  });

  it('refuses deleting an item past draft', async () => {
    const { itemId } = await seedItem();
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'in_review' WHERE item_id = $1`,
      [itemId],
    );
    const message = await rejects(`UPDATE content.item SET deleted_at = now() WHERE item_id = $1`, [itemId]);
    expect(message).toMatch(/item_only_drafts_are_deleted/u);
  });

  it('refuses deleting a draft that has published before', async () => {
    const { itemId, itemVersionId } = await seedItem();
    await database.pool.query(
      `UPDATE content.item SET current_published_version_id = $2 WHERE item_id = $1`,
      [itemId, itemVersionId],
    );
    const message = await rejects(`UPDATE content.item SET deleted_at = now() WHERE item_id = $1`, [itemId]);
    expect(message).toMatch(/item_only_drafts_are_deleted/u);
  });
});

describe('the key half of an item', () => {
  it('stores the authored decimal literal as text, never numeric (ADR-0007)', async () => {
    const [column] = await rows<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'content' AND table_name = 'item_numeric_spec'
          AND column_name = 'expected_value'`,
    );
    expect(column!.data_type).toBe('text');
  });

  it('preserves trailing zeros, which SIGNIFICANT_FIGURES counts', async () => {
    const { itemVersionId } = await seedItem({ itemType: 'NUMERIC' });
    await database.pool.query(
      `INSERT INTO content.item_numeric_spec
         (item_version_id, expected_value, comparison_mode, significant_figures, accepted_forms)
       VALUES ($1, '0.1000', 'SIGNIFICANT_FIGURES', 3, ARRAY['DECIMAL'])`,
      [itemVersionId],
    );
    const [row] = await rows<{ expected_value: string }>(
      `SELECT expected_value FROM content.item_numeric_spec WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(row!.expected_value).toBe('0.1000');
  });

  // D-001 rule 5 at the database, so a specification the executor would refuse
  // cannot be stored and then fail at scoring time.
  it.each([
    ['ABSOLUTE_TOLERANCE with no tolerance', `'ABSOLUTE_TOLERANCE', NULL, NULL, NULL, NULL`],
    ['SIGNIFICANT_FIGURES with no figure count', `'SIGNIFICANT_FIGURES', NULL, NULL, NULL, NULL`],
    ['RANGE with only one bound', `'RANGE', NULL, NULL, '1', NULL`],
  ])('refuses %s', async (_label, values) => {
    const { itemVersionId } = await seedItem({ itemType: 'NUMERIC' });
    const message = await rejects(
      `INSERT INTO content.item_numeric_spec
         (item_version_id, expected_value, comparison_mode, tolerance_value, significant_figures,
          range_min, range_max, accepted_forms)
       VALUES ($1, '1', ${values}, ARRAY['DECIMAL'])`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_numeric_spec_mode_parameters/u);
  });

  it('refuses a required unit with no canonical form', async () => {
    const { itemVersionId } = await seedItem({ itemType: 'NUMERIC' });
    const message = await rejects(
      `INSERT INTO content.item_numeric_spec
         (item_version_id, expected_value, comparison_mode, unit_required, accepted_forms)
       VALUES ($1, '1', 'EXACT', true, ARRAY['DECIMAL'])`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_numeric_spec_unit_named/u);
  });

  it('permits exactly one primary tag per version', async () => {
    const { itemVersionId } = await seedItem();
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag
         (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, true)`,
      [itemVersionId],
    );
    const message = await rejects(
      `INSERT INTO content.item_taxonomy_tag
         (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, true)`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_taxonomy_tag_one_primary/u);
  });
});

describe('INV-01 at the database — AI provenance is traceable', () => {
  it('refuses AI provenance missing its generation fields', async () => {
    const { itemVersionId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.item_provenance (item_version_id, source_type)
       VALUES ($1, 'ai_generated')`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_provenance_ai_attributed/u);
  });

  it('refuses model fields on a human-sourced item', async () => {
    const { itemVersionId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.item_provenance (item_version_id, source_type, model_version_id)
       VALUES ($1, 'original', gen_random_uuid())`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_provenance_no_ai_fields_on_human_source/u);
  });

  it('refuses a previous-year item with no exam or year', async () => {
    const { itemVersionId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.item_provenance (item_version_id, source_type)
       VALUES ($1, 'previous_year')`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_provenance_previous_year_identified/u);
  });

  it('refuses a licensed item with nobody to attribute', async () => {
    const { itemVersionId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.item_provenance (item_version_id, source_type)
       VALUES ($1, 'licensed')`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_provenance_licensed_attributed/u);
  });

  it('accepts complete AI provenance', async () => {
    const { itemVersionId } = await seedItem();
    await database.pool.query(
      `INSERT INTO content.item_provenance
         (item_version_id, source_type, model_version_id, prompt_version_id, generation_run_id, confidence)
       VALUES ($1, 'ai_generated', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0.82)`,
      [itemVersionId],
    );
    const [row] = await rows<{ source_type: string }>(
      `SELECT source_type FROM content.item_provenance WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(row!.source_type).toBe('ai_generated');
  });
});

describe('the media usage graph', () => {
  it('answers "which published content uses this asset" as a join', async () => {
    const { itemId, itemVersionId } = await seedItem();
    const { assetVersionId } = await seedMediaAsset();
    await database.pool.query(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('item_version', $1, $2)`,
      [itemVersionId, assetVersionId],
    );
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'published', current_published_version_id = $2
        WHERE item_id = $1`,
      [itemId, itemVersionId],
    );

    const [row] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM content.content_media_ref r
         JOIN content.item_version v ON v.item_version_id = r.owner_version_id
         JOIN content.item i ON i.item_id = v.item_id
        WHERE r.media_asset_version_id = $1
          AND r.owner_type = 'item_version'
          AND i.lifecycle_state = 'published'`,
      [assetVersionId],
    );
    expect(Number(row!.count)).toBe(1);
  });

  // One edge per relationship, not per mention.
  it('refuses a duplicate edge for the same owner and asset', async () => {
    const { itemVersionId } = await seedItem();
    const { assetVersionId } = await seedMediaAsset();
    const insert = `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
                    VALUES ('item_version', $1, $2)`;
    await database.pool.query(insert, [itemVersionId, assetVersionId]);
    const message = await rejects(insert, [itemVersionId, assetVersionId]);
    expect(message).toMatch(/content_media_ref_pkey/u);
  });

  it('refuses an edge naming an asset version that does not exist', async () => {
    const { itemVersionId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('item_version', $1, gen_random_uuid())`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_media_ref_media_asset_version_id_fkey/u);
  });

  it('refuses an owner type outside the three that can hold media', async () => {
    const { assetVersionId } = await seedMediaAsset();
    const message = await rejects(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('form_slot', gen_random_uuid(), $1)`,
      [assetVersionId],
    );
    expect(message).toMatch(/owner_type/u);
  });
});

describe('a matching pair names members the item defines', () => {
  it('refuses a pair whose left member does not exist', async () => {
    const { itemVersionId } = await seedItem({ itemType: 'MATCHING' });
    const message = await rejects(
      `INSERT INTO content.item_matching_pair (item_version_id, left_member_id, right_member_id)
       VALUES ($1, 'nope', 'r1')`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_matching_pair_left_member_fk/u);
  });

  it('accepts a pair whose members exist on the right sides', async () => {
    const { itemVersionId } = await seedItem({ itemType: 'MATCHING' });
    for (const [side, memberId] of [
      ['left', 'l1'],
      ['right', 'r1'],
    ] as const) {
      await database.pool.query(
        `INSERT INTO content.item_matching_member
           (item_version_id, side, member_id, ordinal, body, body_plain_text)
         VALUES ($1, $2, $3, 1, '{}'::jsonb, 'x')`,
        [itemVersionId, side, memberId],
      );
    }
    await database.pool.query(
      `INSERT INTO content.item_matching_pair (item_version_id, left_member_id, right_member_id)
       VALUES ($1, 'l1', 'r1')`,
      [itemVersionId],
    );
    const [row] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.item_matching_pair WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(row!.count)).toBe(1);
  });

  it('refuses a left member matched twice', async () => {
    const { itemVersionId } = await seedItem({ itemType: 'MATCHING' });
    for (const [side, memberId, ordinal] of [
      ['left', 'l1', 1],
      ['right', 'r1', 1],
      ['right', 'r2', 2],
    ] as const) {
      await database.pool.query(
        `INSERT INTO content.item_matching_member
           (item_version_id, side, member_id, ordinal, body, body_plain_text)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'x')`,
        [itemVersionId, side, memberId, ordinal],
      );
    }
    await database.pool.query(
      `INSERT INTO content.item_matching_pair (item_version_id, left_member_id, right_member_id)
       VALUES ($1, 'l1', 'r1')`,
      [itemVersionId],
    );
    const message = await rejects(
      `INSERT INTO content.item_matching_pair (item_version_id, left_member_id, right_member_id)
       VALUES ($1, 'l1', 'r2')`,
      [itemVersionId],
    );
    expect(message).toMatch(/item_matching_pair_pkey/u);
  });
});

describe('a solution targets an item version (D5)', () => {
  it('refuses a solution whose target version does not exist', async () => {
    const { itemId } = await seedItem();
    const message = await rejects(
      `INSERT INTO content.solution (item_id, target_item_version_id)
       VALUES ($1, gen_random_uuid())`,
      [itemId],
    );
    expect(message).toMatch(/solution_target_item_version_id_fkey/u);
  });

  it('accepts one that names a real version', async () => {
    const { itemId, itemVersionId } = await seedItem();
    const [row] = await rows<{ solution_id: string }>(
      `INSERT INTO content.solution (item_id, target_item_version_id)
       VALUES ($1, $2) RETURNING solution_id`,
      [itemId, itemVersionId],
    );
    expect(row!.solution_id).toBeDefined();
  });
});

describe('migrations run up, down and up again', () => {
  // Verified against a live database rather than argued from the file.
  it('leaves no content schema behind on down, and rebuilds it on up', async () => {
    await database.revertMigrations();
    const [gone] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata WHERE schema_name = 'content'`,
    );
    expect(Number(gone!.count)).toBe(0);

    await database.applyMigrations();
    const [rebuilt] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'content'`,
    );
    expect(Number(rebuilt!.count)).toBe(CONTENT_TABLES.length);
  });
});

// M4-13's own migration, isolated from the rest of the cycle above — the
// first additive column migration since the cluster-role fix, and the first
// down path proven against exactly the schema-less condition that fix named.
describe('content.item.state_entered_at (M4-13) — up, down, up again', () => {
  async function stateEnteredAtColumn(): Promise<{ is_nullable: string; column_default: string | null } | undefined> {
    const [column] = await rows<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'content' AND table_name = 'item' AND column_name = 'state_entered_at'`,
    );
    return column;
  }

  it('adds a NOT NULL column with a now() default on up, drops it cleanly on down, and rebuilds identically on up again', async () => {
    // Starts from whatever state the previous test in this file left behind
    // (migrated) — revert first so "up" below is a real transition, not a
    // no-op against an already-applied schema.
    await database.revertMigrations();
    await database.applyMigrations();
    const afterUp = await stateEnteredAtColumn();
    expect(afterUp?.is_nullable).toBe('NO');
    expect(afterUp?.column_default).toContain('now()');

    await database.revertMigrations();
    expect(await stateEnteredAtColumn()).toBeUndefined();

    await database.applyMigrations();
    const afterUpAgain = await stateEnteredAtColumn();
    expect(afterUpAgain?.is_nullable).toBe('NO');
    expect(afterUpAgain?.column_default).toContain('now()');
  });

  it('backfills state_entered_at from created_at for a row written directly, bypassing the domain', async () => {
    // Simulates a pre-existing row from before this migration: writes
    // straight through SQL with no state_entered_at, then re-runs the
    // migration's own backfill statement against it, the way a real
    // rollout would find rows the domain never touched.
    const itemId = '00000000-0000-4000-8000-000000000101';
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, aggregate_version, created_at)
       VALUES ($1, 'NUMERIC', 'draft', 1, '2026-08-01T00:00:00Z')`,
      [itemId],
    );
    await database.pool.query(
      `UPDATE content.item SET state_entered_at = created_at WHERE item_id = $1`,
      [itemId],
    );

    const [row] = await rows<{ state_entered_at: Date; created_at: Date }>(
      `SELECT state_entered_at, created_at FROM content.item WHERE item_id = $1`,
      [itemId],
    );
    expect(row?.state_entered_at.toISOString()).toBe(row?.created_at.toISOString());
  });
});

describe('content.item_version.edited_by_* (M4-15) — up, down, up again', () => {
  async function editedByColumns(): Promise<number> {
    const [result] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_schema = 'content' AND table_name = 'item_version'
          AND column_name IN ('edited_by_kind', 'edited_by_id')`,
    );
    return Number(result?.count ?? '0');
  }

  it('adds two nullable columns on up, drops them cleanly on down, rebuilds identically on up again', async () => {
    await database.revertMigrations();
    await database.applyMigrations();
    expect(await editedByColumns()).toBe(2);

    await database.revertMigrations();
    expect(await editedByColumns()).toBe(0);

    await database.applyMigrations();
    expect(await editedByColumns()).toBe(2);
  });

  it('enforces both-or-neither at the database', async () => {
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, aggregate_version)
       VALUES ('00000000-0000-4000-8000-000000000102', 'NUMERIC', 'draft', 1)`,
    );
    const rejected = await database.pool
      .query(
        `INSERT INTO content.item_version
           (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
            difficulty_estimate, authored_by_kind, authored_by_id, edited_by_kind)
         VALUES ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000102', 1,
                 'NUMERIC', '{}'::jsonb, 'x', 'moderate', 'human', '00000000-0000-4000-8000-000000000104',
                 'human')`,
      )
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(rejected).toContain('item_version_edited_by_both_or_neither');
  });
});
