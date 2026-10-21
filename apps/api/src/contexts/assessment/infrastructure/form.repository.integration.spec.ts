import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, WINDOW, WITHIN_WINDOW, aDraftForm, aPublishedForm, formSlots, id } from '../../../testing/assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { storePublishedForm } from '../../../testing/assessment-store.js';
import { slotsOf, substituteSlot } from '../domain/form.js';
import { PostgresFormRepository } from './form.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let repository: PostgresFormRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresFormRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
});

describe('saving and finding a form', () => {
  // Field by field against literals, never `toEqual(saved)`: an assertion of
  // one read-back shape against another passes when both are missing the same
  // field (ADR-0017).
  it('reads back every field of a draft, section and slot', async () => {
    expectValue(await repository.save(aDraftForm()));
    const found = expectValue(await repository.findById(id(TAG.form)));

    expect(found.formId).toBe('000000a3-0000-4000-8000-000000000001');
    expect(found.examProfileVersionId).toBe('000000a4-0000-4000-8000-000000000001');
    expect(found.formType).toBe('mock');
    expect(found.state).toBe('draft');
    expect(found.publishedAt).toBeNull();
    expect(found.blueprintConformance['satisfied']).toBe(true);
    expect(found.blueprintConformance['sections']).toBe(2);
    expect(Object.keys(found).sort()).toEqual(['blueprintConformance', 'examProfileVersionId', 'formId', 'formType', 'publishedAt', 'scheduleWindow', 'sections', 'sessionRefs', 'state']);

    expect(found.sections.map((s) => [s.ordinal, s.sectionSpecRef])).toEqual([[1, 'physics-a'], [2, 'physics-b']]);
    const first = found.sections[0]!.slots[0]!;
    expect(first.slotId).toBe('000000b1-0000-4000-8000-000000000001');
    expect(first.ordinal).toBe(1);
    expect(first.itemId).toBe('000000b2-0000-4000-8000-000000000001');
    expect(first.itemVersionId).toBe('000000b3-0000-4000-8000-000000000001');
    expect(first.stimulusVersionId).toBe('000000b4-0000-4000-8000-000000000001');
    expect(first.marksAvailable).toBe(4);
    expect(first.isAnchor).toBe(true);
    expect(Object.keys(first).sort()).toEqual(['isAnchor', 'itemId', 'itemVersionId', 'marksAvailable', 'ordinal', 'slotId', 'stimulusVersionId']);
    const last = found.sections[1]!.slots[2]!;
    expect(last.ordinal).toBe(6);
    expect(last.stimulusVersionId).toBeNull();
    expect(last.isAnchor).toBe(false);
    expect(slotsOf(found)).toHaveLength(6);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('reads back a published form with its publication time and session', async () => {
    await storePublishedForm(database.pool);
    const found = expectValue(await repository.findById(id(TAG.form)));
    expect(found.state).toBe('published');
    expect(found.publishedAt).toBe('2026-10-21T07:00:00.000Z');
    expect(found.sessionRefs).toEqual(['2026-01-27/shift-2']);
    expect(slotsOf(found)).toHaveLength(6);
  });

  it('stores the item version in its own column, and the blueprint report with its schema version', async () => {
    expectValue(await repository.save(aDraftForm()));
    const { rows } = await database.pool.query(
      `SELECT s.item_version_id, s.item_id, f.blueprint_conformance_schema_version AS v
         FROM assessment.form_slot s JOIN assessment.form f USING (form_id) WHERE s.ordinal = 2`,
    );
    expect(rows[0]).toEqual({ item_version_id: id(TAG.itemVersion, 2), item_id: id(TAG.item, 2), v: 1 });
  });

  it('is NotFound for a form that was never saved', async () => {
    expect(expectError(await repository.findById(id(TAG.form, 77))).kind).toBe('NotFound');
  });
});

describe('a draft is edited by saving it again', () => {
  it('replaces the composition: a substitution is a save', async () => {
    const draft = aDraftForm();
    expectValue(await repository.save(draft));
    const target = slotsOf(draft)[2]!;
    const edited = expectValue(substituteSlot(draft, target.slotId, { itemId: id(TAG.item, 50), itemVersionId: id(TAG.itemVersion, 50), stimulusVersionId: null, isAnchor: true }));
    expectValue(await repository.save(edited));
    const found = expectValue(await repository.findById(id(TAG.form)));
    const after = slotsOf(found)[2]!;
    expect(after.slotId).toBe(target.slotId);
    expect(after.itemVersionId).toBe(id(TAG.itemVersion, 50));
    expect(after.isAnchor).toBe(true);
    expect(slotsOf(found)).toHaveLength(6);
  });

  it('can change a draft\'s header too', async () => {
    expectValue(await repository.save(aDraftForm()));
    expectValue(await repository.save(aDraftForm({ formType: 'diagnostic', blueprintConformance: { satisfied: false } })));
    const found = expectValue(await repository.findById(id(TAG.form)));
    expect(found.formType).toBe('diagnostic');
    expect(found.blueprintConformance['satisfied']).toBe(false);
  });

  it('does not publish through save: a published form arriving there is refused, and nothing is stored', async () => {
    const failure = expectError(await repository.save(aPublishedForm()));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('publish()');
    expect(expectError(await repository.findById(id(TAG.form))).kind).toBe('NotFound');
    expectValue(await repository.save(aDraftForm()));
    expect(expectError(await repository.save(aPublishedForm())).code).toBe('PERSISTENCE_REJECTED');
    expect(expectValue(await repository.findById(id(TAG.form))).state).toBe('draft');
  });
});

describe('a published form is never written again (D-006)', () => {
  it('saving the identical form is a no-op, and returns what is stored', async () => {
    const form = await storePublishedForm(database.pool);
    const again = expectValue(await repository.save(form));
    expect(again.publishedAt).toBe(form.publishedAt);
    expect(slotsOf(again)).toHaveLength(6);
  });

  it('refuses a different form under the same id as a conflict, leaving the stored one untouched', async () => {
    await storePublishedForm(database.pool);
    const different = aDraftForm({ formType: 'diagnostic' });
    expect(expectError(await repository.save(different)).code).toBe('CONFLICT');
    const changedSlot = aPublishedForm({
      sections: [
        { ordinal: 1, sectionSpecRef: 'physics-a', slots: formSlots().slice(0, 3).map((slot, i) => (i === 0 ? { ...slot, itemVersionId: id(TAG.itemVersion, 60) } : slot)) },
        { ordinal: 2, sectionSpecRef: 'physics-b', slots: formSlots().slice(3) },
      ],
    });
    expect(expectError(await repository.save(changedSlot)).code).toBe('CONFLICT');
    expect(slotsOf(expectValue(await repository.findById(id(TAG.form))))[0]?.itemVersionId).toBe(id(TAG.itemVersion, 1));
  });

  it('treats a differently-ordered but identical conformance report as the same form', async () => {
    await storePublishedForm(database.pool, { blueprintConformance: { satisfied: true, sections: 2 } });
    const reordered = aPublishedForm({ blueprintConformance: { sections: 2, satisfied: true } });
    expectValue(await repository.save(reordered));
  });
});

describe('scheduling, opening and closing', () => {
  const NOW_SCHEDULING = '2026-10-21T07:30:00.000Z';

  it('schedules a published form and reads the window back, field by field', async () => {
    await storePublishedForm(database.pool);
    const scheduled = expectValue(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING));
    expect(scheduled.state).toBe('embargoed');
    const found = expectValue(await repository.findById(id(TAG.form)));
    expect(found.state).toBe('embargoed');
    expect(found.scheduleWindow?.opensAt).toBe('2026-10-21T08:00:00.000Z');
    expect(found.scheduleWindow?.closesAt).toBe('2026-10-21T12:00:00.000Z');
    expect(found.publishedAt).toBe('2026-10-21T07:00:00.000Z');
    expect(slotsOf(found)).toHaveLength(6);
  });

  it('opens it once the window begins and closes it once the window ends, each a move the domain decided', async () => {
    await storePublishedForm(database.pool);
    expectValue(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING));
    expect(expectError(await repository.open(id(TAG.form), '2026-10-21T07:59:59.000Z')).code).toBe('FORM_WINDOW_NOT_YET_OPEN');
    expect(expectValue(await repository.open(id(TAG.form), WITHIN_WINDOW)).state).toBe('active');
    expect(expectError(await repository.close(id(TAG.form), WITHIN_WINDOW)).code).toBe('FORM_WINDOW_STILL_OPEN');
    const closed = expectValue(await repository.close(id(TAG.form), WINDOW.closesAt));
    expect(closed.state).toBe('closed');
    expect(expectValue(await repository.findById(id(TAG.form))).scheduleWindow?.closesAt).toBe(WINDOW.closesAt);
  });

  it('refuses a move from the wrong state and leaves the stored form as it was', async () => {
    expectValue(await repository.save(aDraftForm()));
    expect(expectError(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING)).code).toBe('FORM_TRANSITION_PROHIBITED');
    expect(expectValue(await repository.findById(id(TAG.form))).state).toBe('draft');
    expect(expectError(await repository.open(id(TAG.form), WITHIN_WINDOW)).code).toBe('FORM_TRANSITION_PROHIBITED');
  });

  it('is NotFound for a form that was never saved, on each move', async () => {
    for (const result of [
      await repository.schedule(id(TAG.form, 77), WINDOW, NOW_SCHEDULING),
      await repository.open(id(TAG.form, 77), WITHIN_WINDOW),
      await repository.close(id(TAG.form, 77), WINDOW.closesAt),
    ]) {
      expect(expectError(result).kind).toBe('NotFound');
    }
  });

  it('lets only one of two simultaneous openings win: the other finds the form already open', async () => {
    await storePublishedForm(database.pool);
    expectValue(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING));
    const results = await Promise.all([repository.open(id(TAG.form), WITHIN_WINDOW), repository.open(id(TAG.form), WITHIN_WINDOW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(expectError(results.find((r) => !r.ok)!).code).toBe('FORM_TRANSITION_PROHIBITED');
  });

  it('finds what a sweep would act on: scheduled forms whose window has begun, open ones whose window has ended', async () => {
    await storePublishedForm(database.pool);
    expectValue(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING));
    expect(expectValue(await repository.findDueToOpen('2026-10-21T07:59:59.000Z', 10))).toEqual([]);
    expect(expectValue(await repository.findDueToOpen(WINDOW.opensAt, 10)).map((f) => f.formId)).toEqual([id(TAG.form)]);
    expect(expectValue(await repository.findDueToClose('2099-01-01T00:00:00.000Z', 10))).toEqual([]);
    expectValue(await repository.open(id(TAG.form), WITHIN_WINDOW));
    expect(expectValue(await repository.findDueToOpen(WINDOW.opensAt, 10))).toEqual([]);
    expect(expectValue(await repository.findDueToClose('2026-10-21T11:59:59.000Z', 10))).toEqual([]);
    const due = expectValue(await repository.findDueToClose(WINDOW.closesAt, 10));
    expect(due.map((f) => [f.formId, f.state])).toEqual([[id(TAG.form), 'active']]);
    expect(expectValue(await repository.findDueToClose(WINDOW.closesAt, 0))).toEqual([]);
  });

  it('reports a connection failure as a value', async () => {
    const { Pool } = await import('pg');
    const broken = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    broken.on('error', () => undefined);
    const repo = new PostgresFormRepository(broken);
    expect(expectError(await repo.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING)).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await repo.findDueToOpen(WINDOW.opensAt, 1)).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await repo.findDueToClose(WINDOW.opensAt, 1)).code).toBe('PERSISTENCE_REJECTED');
    await broken.end().catch(() => undefined);
  });

  it('rolls a move back when the database refuses it, and reports the refusal as a value', async () => {
    await storePublishedForm(database.pool);
    // A trigger planted for this test only: the domain would allow the move, the database does not.
    await database.pool.query(
      `CREATE TRIGGER zz_refuse_everything BEFORE UPDATE ON assessment.form FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation()`,
    );
    try {
      expect(expectError(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING)).code).toBe('PERSISTENCE_REJECTED');
    } finally {
      await database.pool.query('DROP TRIGGER zz_refuse_everything ON assessment.form');
    }
    expect(expectValue(await repository.findById(id(TAG.form))).state).toBe('published');
  });

  it('refuses to move a stored form that no longer satisfies the domain', async () => {
    await storePublishedForm(database.pool);
    expectValue(await repository.schedule(id(TAG.form), WINDOW, NOW_SCHEDULING));
    const client = await database.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query('DELETE FROM assessment.exposure_ledger_entry');
      await client.query('DELETE FROM assessment.form_slot WHERE section_ordinal = 2');
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
    expect(expectError(await repository.open(id(TAG.form), WITHIN_WINDOW)).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await repository.findDueToOpen(WINDOW.opensAt, 5)).kind).toBe('Validation');
  });
});

describe('what the store refuses', () => {
  it('writes all or nothing: a slot id another form already holds rolls the whole save back', async () => {
    expectValue(await repository.save(aDraftForm()));
    const clash = aDraftForm({ formId: id(TAG.form, 2) });
    const failure = expectError(await repository.save(clash));
    expect(failure.code).toBe('CONFLICT');
    expect(failure.location).toBe('form_slot_pkey');
    expect(expectError(await repository.findById(id(TAG.form, 2))).kind).toBe('NotFound');
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM assessment.form_section`)).rows[0]).toEqual({ n: 2 });
  });

  it('reports a rejected write as a value, never an exception', async () => {
    const closed = new PostgresFormRepository(await brokenPool());
    expect(expectError(await closed.save(aDraftForm())).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await closed.findById(id(TAG.form))).code).toBe('PERSISTENCE_REJECTED');
  });

  it('refuses to load a stored form that no longer satisfies the domain', async () => {
    expectValue(await repository.save(aDraftForm()));
    await database.pool.query(`ALTER TABLE assessment.form DISABLE TRIGGER form_immutable_once_published`);
    try {
      await database.pool.query(`UPDATE assessment.form SET form_type = 'mock', exam_profile_version_id = exam_profile_version_id`);
      await database.pool.query(`ALTER TABLE assessment.form_section DISABLE TRIGGER form_section_frozen_with_its_form`);
      await database.pool.query(`UPDATE assessment.form_section SET section_spec_ref = 'x'`);
      await database.pool.query(`ALTER TABLE assessment.form_section ENABLE TRIGGER form_section_frozen_with_its_form`);
      // a slot's section pointing at nothing leaves a section with no slots: not a form
      await database.pool.query(`ALTER TABLE assessment.form_slot DISABLE TRIGGER form_slot_frozen_with_its_form`);
      await database.pool.query(`DELETE FROM assessment.form_slot WHERE section_ordinal = 2`);
      await database.pool.query(`ALTER TABLE assessment.form_slot ENABLE TRIGGER form_slot_frozen_with_its_form`);
    } finally {
      await database.pool.query(`ALTER TABLE assessment.form ENABLE TRIGGER form_immutable_once_published`);
    }
    const failure = expectError(await repository.findById(id(TAG.form)));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('FORM_SECTIONS_INVALID');
  });

  it('refuses to publish a stored draft that no longer satisfies the domain, and publishes nothing', async () => {
    expectValue(await repository.save(aDraftForm()));
    const client = await database.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query('DELETE FROM assessment.form_slot WHERE section_ordinal = 2');
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
    const failure = expectError(await repository.publish(id(TAG.form), '2026-10-21T07:00:00.000Z'));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry')).rows[0]).toEqual({ n: 0 });
  });

  it('reports a failure on the second read of a published form that is saved again', async () => {
    const form = await storePublishedForm(database.pool);
    // The database would never let this happen, so triggers and keys are set aside for one statement on one connection.
    const client = await database.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query('DELETE FROM assessment.form_slot');
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
    expect(expectError(await repository.save(form)).code).toBe('PERSISTENCE_REJECTED');
  });
});

/** A pool whose every query fails, to prove a store error never escapes as an exception. */
async function brokenPool() {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
  pool.on('error', () => undefined);
  return pool;
}
