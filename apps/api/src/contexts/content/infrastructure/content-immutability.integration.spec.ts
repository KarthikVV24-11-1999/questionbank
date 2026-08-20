import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';

/**
 * INV-03 at the database, proven the way M1 and M2 proved theirs: by issuing
 * the mutation and reading the refusal, not by inspecting the trigger.
 *
 * These run through the same pool the repositories use, which is a *stronger*
 * claim than an ORM-level test — the trigger is not role-aware, so what is
 * refused here is refused from `psql` too. The raw-`psql` transcript is in the
 * commit body.
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

interface SeededItem {
  readonly itemId: string;
  readonly itemVersionId: string;
}

async function seedDraftItem(): Promise<SeededItem> {
  const [item] = await rows<{ item_id: string }>(
    `INSERT INTO content.item (item_type) VALUES ('SINGLE_CORRECT_MCQ') RETURNING item_id`,
  );
  const [version] = await rows<{ item_version_id: string }>(
    `INSERT INTO content.item_version
       (item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 'a stem', 'moderate', 'human', gen_random_uuid())
     RETURNING item_version_id`,
    [item!.item_id],
  );
  const itemVersionId = version!.item_version_id;

  await database.pool.query(
    `INSERT INTO content.item_option (item_version_id, option_id, ordinal, body, body_plain_text, is_correct)
     VALUES ($1, 'a', 1, '{}'::jsonb, 'option a', true),
            ($1, 'b', 2, '{}'::jsonb, 'option b', false)`,
    [itemVersionId],
  );
  await database.pool.query(
    `INSERT INTO content.item_taxonomy_tag
       (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
     VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, true)`,
    [itemVersionId],
  );
  await database.pool.query(
    `INSERT INTO content.item_provenance (item_version_id, source_type) VALUES ($1, 'original')`,
    [itemVersionId],
  );

  return { itemId: item!.item_id, itemVersionId };
}

async function publish(itemVersionId: string): Promise<void> {
  await database.pool.query(
    `UPDATE content.item_version SET published_at = now() WHERE item_version_id = $1`,
    [itemVersionId],
  );
}

async function seedPublishedItem(): Promise<SeededItem> {
  const seeded = await seedDraftItem();
  await publish(seeded.itemVersionId);
  return seeded;
}

describe('a draft version is editable — that is what the draft state is for', () => {
  it('permits editing the stem', async () => {
    const { itemVersionId } = await seedDraftItem();
    await database.pool.query(
      `UPDATE content.item_version SET stem_plain_text = 'revised' WHERE item_version_id = $1`,
      [itemVersionId],
    );
    const [row] = await rows<{ stem_plain_text: string }>(
      `SELECT stem_plain_text FROM content.item_version WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(row!.stem_plain_text).toBe('revised');
  });

  it('permits changing the answer key', async () => {
    const { itemVersionId } = await seedDraftItem();
    await database.pool.query(
      `UPDATE content.item_option SET is_correct = NOT is_correct WHERE item_version_id = $1`,
      [itemVersionId],
    );
    const [row] = await rows<{ option_id: string }>(
      `SELECT option_id FROM content.item_option WHERE item_version_id = $1 AND is_correct`,
      [itemVersionId],
    );
    expect(row!.option_id).toBe('b');
  });

  it('permits adding and removing an option', async () => {
    const { itemVersionId } = await seedDraftItem();
    await database.pool.query(
      `INSERT INTO content.item_option (item_version_id, option_id, ordinal, body, body_plain_text)
       VALUES ($1, 'c', 3, '{}'::jsonb, 'option c')`,
      [itemVersionId],
    );
    await database.pool.query(
      `DELETE FROM content.item_option WHERE item_version_id = $1 AND option_id = 'c'`,
      [itemVersionId],
    );
    const [row] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.item_option WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(row!.count)).toBe(2);
  });

  it('permits discarding the draft version entirely', async () => {
    const { itemVersionId } = await seedDraftItem();
    await database.pool.query(`DELETE FROM content.item_version WHERE item_version_id = $1`, [
      itemVersionId,
    ]);
    const [row] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.item_version WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(row!.count)).toBe(0);
  });
});

describe('a published version is immutable (INV-03)', () => {
  it('refuses an edit to the version row', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_version SET stem_plain_text = 'tampered' WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses deleting the version', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(`DELETE FROM content.item_version WHERE item_version_id = $1`, [
      itemVersionId,
    ]);
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  // A version that was published and then superseded must still reproduce,
  // because an attempt is pinned to it (INV-04). "Ever published" is the test,
  // not "currently published".
  it('stays immutable after it is superseded', async () => {
    const { itemId, itemVersionId } = await seedPublishedItem();
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id, published_at)
       VALUES ($1, 2, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 'v2', 'moderate', 'human', gen_random_uuid(), now())`,
      [itemId],
    );
    const message = await rejects(
      `UPDATE content.item_version SET stem_plain_text = 'tampered' WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses clearing published_at to unlock the version', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_version SET published_at = NULL WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('names the instant it was published, so the refusal is diagnosable', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_version SET stem_plain_text = 'x' WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/published at \d{4}-\d{2}-\d{2}/u);
  });
});

describe('a published version’s parts freeze with it', () => {
  // Otherwise a published item's key could be edited without touching the row
  // that claims to be immutable — the exact hole INV-03 exists to close.
  it('refuses changing which option is correct', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_option SET is_correct = true WHERE item_version_id = $1 AND option_id = 'b'`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses adding an option', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `INSERT INTO content.item_option (item_version_id, option_id, ordinal, body, body_plain_text)
       VALUES ($1, 'z', 9, '{}'::jsonb, 'z')`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses deleting an option', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `DELETE FROM content.item_option WHERE item_version_id = $1 AND option_id = 'b'`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses retagging', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_taxonomy_tag SET weight = 0.5 WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses rewriting provenance (FR-QM-05 rule 5)', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const message = await rejects(
      `UPDATE content.item_provenance SET source_type = 'licensed', author_ref = 'someone'
        WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses editing a numeric specification once published', async () => {
    const [item] = await rows<{ item_id: string }>(
      `INSERT INTO content.item (item_type) VALUES ('NUMERIC') RETURNING item_id`,
    );
    const [version] = await rows<{ item_version_id: string }>(
      `INSERT INTO content.item_version
         (item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'NUMERIC', '{}'::jsonb, 's', 'moderate', 'human', gen_random_uuid())
       RETURNING item_version_id`,
      [item!.item_id],
    );
    await database.pool.query(
      `INSERT INTO content.item_numeric_spec
         (item_version_id, expected_value, comparison_mode, tolerance_value, accepted_forms)
       VALUES ($1, '9.81', 'ABSOLUTE_TOLERANCE', '0.01', ARRAY['DECIMAL'])`,
      [version!.item_version_id],
    );
    await publish(version!.item_version_id);

    const message = await rejects(
      `UPDATE content.item_numeric_spec SET expected_value = '1.0' WHERE item_version_id = $1`,
      [version!.item_version_id],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('still permits editing the parts of a draft version', async () => {
    const { itemVersionId } = await seedDraftItem();
    await database.pool.query(
      `UPDATE content.item_taxonomy_tag SET weight = 0.5 WHERE item_version_id = $1`,
      [itemVersionId],
    );
    const [row] = await rows<{ weight: string }>(
      `SELECT weight FROM content.item_taxonomy_tag WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(row!.weight)).toBe(0.5);
  });
});

describe('the media usage graph freezes with its owner', () => {
  async function seedAssetVersion(): Promise<string> {
    const [asset] = await rows<{ asset_id: string }>(
      `INSERT INTO content.media_asset (asset_type) VALUES ('photograph') RETURNING asset_id`,
    );
    const [version] = await rows<{ asset_version_id: string }>(
      `INSERT INTO content.media_asset_version
         (asset_id, version_no, storage_key, checksum, mime_type, width, height, alt_text,
          authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'k', 'c', 'image/png', 10, 10, 'alt', 'human', gen_random_uuid())
       RETURNING asset_version_id`,
      [asset!.asset_id],
    );
    return version!.asset_version_id;
  }

  // If an edge could be removed from a published item, the asset would then
  // look unused — which is exactly the reading FR-QM-06 rule 3 relies on to
  // refuse retirement.
  it('refuses removing an edge from a published version', async () => {
    const { itemVersionId } = await seedDraftItem();
    const assetVersionId = await seedAssetVersion();
    await database.pool.query(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('item_version', $1, $2)`,
      [itemVersionId, assetVersionId],
    );
    await publish(itemVersionId);

    const message = await rejects(
      `DELETE FROM content.content_media_ref WHERE owner_version_id = $1`,
      [itemVersionId],
    );
    expect(message).toMatch(/media usage graph freezes/u);
  });

  it('refuses adding an edge to a published version', async () => {
    const { itemVersionId } = await seedPublishedItem();
    const assetVersionId = await seedAssetVersion();
    const message = await rejects(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('item_version', $1, $2)`,
      [itemVersionId, assetVersionId],
    );
    expect(message).toMatch(/media usage graph freezes/u);
  });

  it('permits editing the graph for a draft version', async () => {
    const { itemVersionId } = await seedDraftItem();
    const assetVersionId = await seedAssetVersion();
    await database.pool.query(
      `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
       VALUES ('item_version', $1, $2)`,
      [itemVersionId, assetVersionId],
    );
    await database.pool.query(`DELETE FROM content.content_media_ref WHERE owner_version_id = $1`, [
      itemVersionId,
    ]);
    const [row] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.content_media_ref WHERE owner_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(row!.count)).toBe(0);
  });
});

describe('the other aggregates freeze the same way', () => {
  it('refuses editing a published stimulus version', async () => {
    const [stimulus] = await rows<{ stimulus_id: string }>(
      `INSERT INTO content.stimulus (stimulus_type) VALUES ('passage') RETURNING stimulus_id`,
    );
    const [version] = await rows<{ stimulus_version_id: string }>(
      `INSERT INTO content.stimulus_version
         (stimulus_id, version_no, body, body_plain_text, authored_by_kind, authored_by_id, published_at)
       VALUES ($1, 1, '{}'::jsonb, 'a passage', 'human', gen_random_uuid(), now())
       RETURNING stimulus_version_id`,
      [stimulus!.stimulus_id],
    );
    const message = await rejects(
      `UPDATE content.stimulus_version SET body_plain_text = 'x' WHERE stimulus_version_id = $1`,
      [version!.stimulus_version_id],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses editing a published solution version and its steps', async () => {
    const { itemId, itemVersionId } = await seedDraftItem();
    const [solution] = await rows<{ solution_id: string }>(
      `INSERT INTO content.solution (item_id, target_item_version_id) VALUES ($1, $2) RETURNING solution_id`,
      [itemId, itemVersionId],
    );
    const [version] = await rows<{ solution_version_id: string }>(
      `INSERT INTO content.solution_version
         (solution_id, version_no, final_answer_kind, final_answer, authored_by_kind, authored_by_id)
       VALUES ($1, 1, 'OPTION', '{"kind":"OPTION","optionId":"a"}'::jsonb, 'human', gen_random_uuid())
       RETURNING solution_version_id`,
      [solution!.solution_id],
    );
    await database.pool.query(
      `INSERT INTO content.solution_step (solution_version_id, ordinal, body, body_plain_text)
       VALUES ($1, 1, '{}'::jsonb, 'step one')`,
      [version!.solution_version_id],
    );
    await database.pool.query(
      `UPDATE content.solution_version SET published_at = now() WHERE solution_version_id = $1`,
      [version!.solution_version_id],
    );

    expect(
      await rejects(
        `UPDATE content.solution_version SET final_answer_kind = 'NUMERIC' WHERE solution_version_id = $1`,
        [version!.solution_version_id],
      ),
    ).toMatch(/content_published_version_is_immutable/u);

    expect(
      await rejects(`UPDATE content.solution_step SET body_plain_text = 'x' WHERE solution_version_id = $1`, [
        version!.solution_version_id,
      ]),
    ).toMatch(/content_published_version_is_immutable/u);
  });

  it('refuses editing a published media asset version', async () => {
    const [asset] = await rows<{ asset_id: string }>(
      `INSERT INTO content.media_asset (asset_type) VALUES ('photograph') RETURNING asset_id`,
    );
    const [version] = await rows<{ asset_version_id: string }>(
      `INSERT INTO content.media_asset_version
         (asset_id, version_no, storage_key, checksum, mime_type, width, height, alt_text,
          authored_by_kind, authored_by_id, published_at)
       VALUES ($1, 1, 'k', 'c', 'image/png', 10, 10, 'alt', 'human', gen_random_uuid(), now())
       RETURNING asset_version_id`,
      [asset!.asset_id],
    );
    const message = await rejects(
      `UPDATE content.media_asset_version SET storage_key = 'swapped' WHERE asset_version_id = $1`,
      [version!.asset_version_id],
    );
    expect(message).toMatch(/content_published_version_is_immutable/u);
  });
});

describe('the trigger surface itself', () => {
  it('guards every version table and every part table', async () => {
    // Scoped to INV-03's own trigger functions, not "every trigger in
    // content" — M4-21 adds a second, unrelated immutability policy
    // (append-only / state-machine) to the review tables, and conflating
    // the two closed lists would make each less able to say what it means.
    const guarded = await rows<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'content' AND NOT t.tgisinternal AND p.proname LIKE 'reject_published%'
        ORDER BY c.relname`,
    );
    expect(guarded.map((row) => row.table_name)).toEqual([
      'alternate_approach',
      'content_licensing',
      'content_media_ref',
      'distractor_analysis',
      'item_matching_member',
      'item_matching_pair',
      'item_numeric_spec',
      'item_option',
      'item_provenance',
      'item_taxonomy_tag',
      'item_version',
      'media_asset_version',
      'solution_step',
      'solution_version',
      'stimulus_version',
    ]);
  });

  // §9 rule 11 adapted: UPDATE and DELETE grants are kept because drafts need
  // them, so TRUNCATE is the one path where the grant rather than the trigger
  // is the control. A row trigger cannot see it.
  it('holds no TRUNCATE grant for the app role on any guarded table', async () => {
    const [roleExists] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_roles WHERE rolname = 'questionbank_app'`,
    );
    if (Number(roleExists!.count) === 0) {
      // ADR-0004: the deployment role does not exist locally. The migration is
      // conditional for the same reason, and this is recorded rather than
      // silently passing as if it had been checked.
      expect(Number(roleExists!.count)).toBe(0);
      return;
    }

    const granted = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'content' AND grantee = 'questionbank_app' AND privilege_type = 'TRUNCATE'`,
    );
    expect(granted).toEqual([]);
  });
});

describe('migrations run up, down and up again with the triggers in place', () => {
  it('drops and rebuilds cleanly', async () => {
    await database.revertMigrations();
    const [gone] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata WHERE schema_name = 'content'`,
    );
    expect(Number(gone!.count)).toBe(0);

    await database.applyMigrations();
    const [triggers] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'content' AND NOT t.tgisinternal AND p.proname LIKE 'reject_published%'`,
    );
    expect(Number(triggers!.count)).toBe(15);
  });
});
