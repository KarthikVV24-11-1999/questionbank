import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, aDraftForm, aPublishedForm, formSlots, id } from '../../../testing/assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { publishForm, slotsOf, substituteSlot } from '../domain/form.js';
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
  await database.pool.query('TRUNCATE assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
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
    expect(Object.keys(found).sort()).toEqual(['blueprintConformance', 'examProfileVersionId', 'formId', 'formType', 'publishedAt', 'sections', 'state']);

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

  it('reads back a published form with its publication time', async () => {
    expectValue(await repository.save(aPublishedForm()));
    const found = expectValue(await repository.findById(id(TAG.form)));
    expect(found.state).toBe('published');
    expect(found.publishedAt).toBe('2026-10-21T07:00:00.000Z');
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

  it('publishes a saved draft by saving the published form', async () => {
    const draft = aDraftForm();
    expectValue(await repository.save(draft));
    expectValue(await repository.save(expectValue(publishForm(draft, '2026-10-21T07:00:00.000Z'))));
    expect(expectValue(await repository.findById(id(TAG.form))).state).toBe('published');
  });
});

describe('a published form is never written again (D-006)', () => {
  it('saving the identical form is a no-op, and returns what is stored', async () => {
    const form = aPublishedForm();
    expectValue(await repository.save(form));
    const again = expectValue(await repository.save(form));
    expect(again.publishedAt).toBe(form.publishedAt);
    expect(slotsOf(again)).toHaveLength(6);
  });

  it('refuses a different form under the same id as a conflict, leaving the stored one untouched', async () => {
    expectValue(await repository.save(aPublishedForm()));
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
    expectValue(await repository.save(aPublishedForm({ blueprintConformance: { satisfied: true, sections: 2 } })));
    const reordered = aPublishedForm({ blueprintConformance: { sections: 2, satisfied: true } });
    expectValue(await repository.save(reordered));
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

  it('reports a failure on the second read of a published form that is saved again', async () => {
    const form = aPublishedForm();
    expectValue(await repository.save(form));
    await database.pool.query(`ALTER TABLE assessment.form_slot DISABLE TRIGGER form_slot_frozen_with_its_form`);
    try {
      await database.pool.query(`DELETE FROM assessment.form_slot`);
    } finally {
      await database.pool.query(`ALTER TABLE assessment.form_slot ENABLE TRIGGER form_slot_frozen_with_its_form`);
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
