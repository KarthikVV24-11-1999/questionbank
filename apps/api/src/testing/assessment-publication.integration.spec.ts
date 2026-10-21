import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { meetsAnchorFloor } from '../contexts/assessment/domain/form.js';
import { NOW_ISO, refusal, seedForm } from './assessment-db.js';
import { SESSION_REF, TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M6-19 — publication held at the database. Each refusal is proven by
 * attempting the write; each trigger is shown to be the one refusing by
 * dropping it in a rolled-back transaction.
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

beforeEach(async () => {
  await database.pool.query(
    'TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE',
  );
});

const publish = (formId = id(TAG.form)) =>
  database.pool.query(`UPDATE assessment.form SET state = 'published', published_at = $2 WHERE form_id = $1`, [formId, NOW_ISO]);

const writeLedger = (formId = id(TAG.form)) =>
  database.pool.query(
    `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
     SELECT form_id, slot_id, item_id, item_version_id, $2, is_anchor, $3 FROM assessment.form_slot WHERE form_id = $1`,
    [formId, SESSION_REF, NOW_ISO],
  );

const addToPool = (n = 1) =>
  database.pool.query(`INSERT INTO assessment.anchor_pool_member (item_version_id, exposure_cap, added_at) VALUES ($1, 40, '2026-10-01T00:00:00Z')`, [id(TAG.itemVersion, n)]);

describe('a form is born a draft', () => {
  it('refuses an INSERT as published, so the publication guard cannot be skipped by never updating', async () => {
    const message = await refusal(() =>
      database.pool.query(
        `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, session_ref, blueprint_conformance, state, published_at)
         VALUES ($1, $2, 'mock', 's', '{"satisfied": true}', 'published', now())`,
        [id(TAG.form), id(TAG.profile)],
      ),
    );
    expect(message).toContain('assessment_form_is_born_a_draft');
  });
});

describe('a draft becomes published only when it is fit to be', () => {
  it('publishes once the pool has its anchor, the ledger has every slot and the blueprint was satisfied', async () => {
    await seedForm(database.pool, { publish: false });
    await addToPool();
    await writeLedger();
    await publish();
    expect((await database.pool.query('SELECT state FROM assessment.form')).rows[0].state).toBe('published');
  });

  it('refuses without a ledger row for every slot — even one short', async () => {
    await seedForm(database.pool, { publish: false });
    await addToPool();
    expect(await refusal(publish)).toContain('assessment_publication_requires_ledger');
    await writeLedger();
    const client = await database.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query('DELETE FROM assessment.exposure_ledger_entry WHERE slot_id = $1', [id(TAG.slot, 6)]);
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
    expect(await refusal(publish)).toContain('assessment_publication_requires_ledger');
  });

  it('refuses when a slot flagged an anchor is not in the pool, and when a pool member is left unflagged', async () => {
    await seedForm(database.pool, { publish: false });
    await writeLedger();
    expect(await refusal(publish)).toContain('assessment_publication_anchor_flag_disagrees_with_pool');
    await addToPool(1);
    await addToPool(4);
    expect(await refusal(publish)).toContain('assessment_publication_anchor_flag_disagrees_with_pool');
  });

  it('a retired pool member no longer counts as an anchor', async () => {
    await seedForm(database.pool, { publish: false });
    await addToPool();
    await writeLedger();
    await database.pool.query(`UPDATE assessment.anchor_pool_member SET retired_at = '2026-10-02T00:00:00Z'`);
    expect(await refusal(publish)).toContain('assessment_publication_anchor_flag_disagrees_with_pool');
  });

  it('refuses a form below 15% anchors, naming F50', async () => {
    await seedForm(database.pool, { publish: false });
    await database.pool.query(`UPDATE assessment.form_slot SET is_anchor = false`);
    await writeLedger();
    const message = await refusal(publish);
    expect(message).toContain('assessment_publication_anchor_floor');
    expect(message).toContain('F50');
  });

  it('refuses a form whose blueprint report does not say it was satisfied', async () => {
    await seedForm(database.pool, { publish: false });
    await addToPool();
    await writeLedger();
    await database.pool.query(`UPDATE assessment.form SET blueprint_conformance = '{"satisfied": false}'`);
    expect(await refusal(publish)).toContain('assessment_publication_requires_conformance');
    await database.pool.query(`UPDATE assessment.form SET blueprint_conformance = '{}'`);
    expect(await refusal(publish)).toContain('assessment_publication_requires_conformance');
  });

  it('leaves the form a draft each time it refuses', async () => {
    await seedForm(database.pool, { publish: false });
    await refusal(publish);
    expect((await database.pool.query('SELECT state, published_at FROM assessment.form')).rows[0]).toEqual({ state: 'draft', published_at: null });
  });

  it('is the trigger that refuses: with it dropped, a form with no ledger and no pool is published', async () => {
    await seedForm(database.pool, { publish: false });
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER form_publication_guarded ON assessment.form');
      const result = await client.query(`UPDATE assessment.form SET state = 'published', published_at = now()`);
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('the SQL anchor floor agrees with the domain\'s over every form size', () => {
  // Two implementations of one rule (rule 5): asserted over the whole grid, not a sample.
  it('answers the same for every anchor count up to every total up to 40', async () => {
    const { rows } = await database.pool.query<{ anchors: number; total: number; met: boolean }>(
      `SELECT k AS anchors, n AS total, assessment.anchor_floor_met(k, n) AS met
         FROM generate_series(0, 40) AS n, LATERAL generate_series(0, n) AS k`,
    );
    expect(rows).toHaveLength((41 * 42) / 2);
    const disagreeing = rows.filter((row) => row.met !== meetsAnchorFloor(row.anchors, row.total));
    expect(disagreeing).toEqual([]);
  });

  it('is not vacuous: the grid has cases on both sides of the line', async () => {
    const { rows } = await database.pool.query<{ met: boolean; n: number }>(
      `SELECT assessment.anchor_floor_met(k, n) AS met, count(*)::int AS n FROM generate_series(0, 40) AS n, LATERAL generate_series(0, n) AS k GROUP BY 1`,
    );
    expect(rows.map((row) => row.met).sort()).toEqual([false, true]);
  });
});

describe('a published form stays immutable at the database (D-006)', () => {
  it('refuses the update, the delete and a slot swap by attempting them', async () => {
    await seedForm(database.pool);
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form SET form_type = 'diagnostic'`))).toContain('assessment_published_form_is_immutable');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.form`))).toContain('assessment_published_form_is_immutable');
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form_slot SET item_version_id = $1`, [id(TAG.itemVersion, 99)]))).toContain('assessment_published_form_is_immutable');
  });
});
