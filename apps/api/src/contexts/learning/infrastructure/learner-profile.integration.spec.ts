import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { chooseExam, clearScope, declareScope, newProfile, setCurrentClass, setPriorScore, skipOnboarding, type LearnerProfile } from '../domain/learner-profile.js';
import { PostgresLearnerProfileStore } from './learner-profile.repository.js';

let database: TestDatabase;
const T0 = '2026-11-04T09:00:00.000Z';
const T1 = '2026-11-04T09:05:00.000Z';
const TAXONOMY = randomUUID();
const CHOICE = { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: randomUUID(), taxonomyVersionId: TAXONOMY };
const NODES = [randomUUID(), randomUUID()];
const CONCEPTS = [randomUUID(), randomUUID(), randomUUID()];
const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

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
  await database.pool.query('DELETE FROM learning.learner_profile');
});

const store = () => new PostgresLearnerProfileStore(database.pool);
const full = (learnerRef: string): LearnerProfile =>
  must(declareScope(must(setPriorScore(must(setCurrentClass(must(chooseExam(newProfile(learnerRef, T0), CHOICE, T0)), 'class_12', T0)), { value: 187.5, outOf: 300 }, T0)), { taxonomyVersionId: TAXONOMY, nodeIds: NODES, conceptIdentityIds: CONCEPTS, conceptTotal: 40 }, T1));

describe('the learner profile is stored whole, one per learner (M8-18)', () => {
  it('finds nothing for a learner who has none', async () => {
    expect(await store().find(randomUUID())).toEqual({ ok: true, value: null });
  });

  it('keeps an empty profile: partial from the start is a state, not an error', async () => {
    const learner = randomUUID();
    const profile = newProfile(learner, T0);
    expect(await store().save(profile, null)).toEqual({ ok: true, value: profile });
    expect(await store().find(learner)).toEqual({ ok: true, value: profile });
  });

  it('keeps everything a profile holds and gives back the same profile: the exam and the versions it resolved to, the class, the prior score as a number, the scope', async () => {
    const learner = randomUUID();
    const profile = full(learner);
    const first = must(await store().save(newProfile(learner, T0), null));
    expect(must(await store().save({ ...profile, version: 2 }, first.version))).toEqual({ ...profile, version: 2 });
    expect(must(await store().find(learner))).toEqual({ ...profile, version: 2 });
  });

  it('keeps a skip, and loses it when the next save is the learner carrying on', async () => {
    const learner = randomUUID();
    const first = must(await store().save(newProfile(learner, T0), null));
    const skipped = must(await store().save(skipOnboarding(first, T1), first.version));
    expect(must(await store().find(learner))!.onboardingSkippedAt).toBe(T1);
    must(await store().save(must(setCurrentClass(skipped, 'class_11', T1)), skipped.version));
    expect(must(await store().find(learner))).toMatchObject({ onboardingSkippedAt: null, currentClass: 'class_11', version: 3 });
  });

  it('takes the scope away when it is cleared, and every column of it with it', async () => {
    const learner = randomUUID();
    const first = must(await store().save(newProfile(learner, T0), null));
    const scoped = must(await store().save(must(declareScope(first, { taxonomyVersionId: TAXONOMY, nodeIds: NODES, conceptIdentityIds: CONCEPTS, conceptTotal: 40 }, T0)), first.version));
    must(await store().save(clearScope(scoped, T1), scoped.version));
    expect(must(await store().find(learner))!.scope).toBeNull();
    const row = (await database.pool.query('SELECT scope_taxonomy_version_id, scope_node_ids, scope_concept_ids, scope_concept_total FROM learning.learner_profile WHERE learner_ref = $1', [learner])).rows[0];
    expect(row).toEqual({ scope_taxonomy_version_id: null, scope_node_ids: null, scope_concept_ids: null, scope_concept_total: null });
  });

  it('reads and writes only the learner\'s own row', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    must(await store().save(newProfile(a, T0), null));
    must(await store().save(newProfile(b, T0), null));
    const first = must(await store().find(a))!;
    must(await store().save(must(setCurrentClass(first, 'repeater', T1)), first.version));
    expect(must(await store().find(b))!.currentClass).toBeNull();
    expect(must(await store().find(a))!.currentClass).toBe('repeater');
  });
});

describe('two writers do not overwrite each other', () => {
  it('refuses a save made over a version that has been replaced, and changes nothing', async () => {
    const learner = randomUUID();
    const first = must(await store().save(newProfile(learner, T0), null));
    must(await store().save(must(setCurrentClass(first, 'class_11', T1)), first.version));
    const stale = await store().save(must(setCurrentClass(first, 'class_12', T1)), first.version);
    expect(stale).toMatchObject({ ok: false, error: { kind: 'Conflict', code: 'PROFILE_CHANGED' } });
    expect(must(await store().find(learner))!.currentClass).toBe('class_11');
  });

  it('refuses a first save for a learner who already has a profile', async () => {
    const learner = randomUUID();
    must(await store().save(newProfile(learner, T0), null));
    expect(await store().save(newProfile(learner, T1), null)).toMatchObject({ ok: false, error: { code: 'PROFILE_CHANGED' } });
  });

  it('takes a save that carries several changes over the version it read: the version stored is the profile\'s own', async () => {
    const learner = randomUUID();
    const first = must(await store().save(newProfile(learner, T0), null));
    const several = must(setCurrentClass(must(setPriorScore(first, { value: 1, outOf: 2 }, T1)), 'class_12', T1));
    expect(several.version).toBe(first.version + 2);
    expect(must(await store().save(several, first.version)).version).toBe(first.version + 2);
    expect(must(await store().save(must(setCurrentClass(several, 'class_11', T1)), several.version)).version).toBe(first.version + 3);
  });

  it('lets exactly one of two saves over the same version through', async () => {
    const learner = randomUUID();
    const first = must(await store().save(newProfile(learner, T0), null));
    const results = await Promise.all([store().save(must(setCurrentClass(first, 'class_11', T1)), first.version), store().save(must(setCurrentClass(first, 'class_12', T1)), first.version)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});

describe('the table holds together what must hold together', () => {
  const raw = (sql: string, values: unknown[] = []) => database.pool.query(sql, values);
  const insert = (columns: string, placeholders: string, values: unknown[]) => raw(`INSERT INTO learning.learner_profile (learner_ref, created_at, updated_at, ${columns}) VALUES ($1, now(), now(), ${placeholders})`, [randomUUID(), ...values]);

  it('refuses an exam without a year, and a year without an exam', async () => {
    await expect(insert('exam_code', '$2', ['JEE_MAIN'])).rejects.toThrow(/exam_and_year_together/u);
    await expect(insert('target_year', '$2', ['2027'])).rejects.toThrow(/exam_and_year_together/u);
  });

  it('refuses a resolved version for a profile with no exam, and a year that is not one', async () => {
    await expect(insert('exam_profile_version_id, taxonomy_version_id', '$2, $3', [randomUUID(), randomUUID()])).rejects.toThrow(/resolution_needs_an_exam/u);
    await expect(insert('exam_code, target_year', '$2, $3', ['JEE_MAIN', 'soon'])).rejects.toThrow(/target_year/u);
  });

  it('refuses a score without its maximum, one above it, and a class the form does not offer', async () => {
    await expect(insert('prior_score_value', '$2', [10])).rejects.toThrow(/prior_score_whole/u);
    await expect(insert('prior_score_value, prior_score_out_of', '$2, $3', [301, 300])).rejects.toThrow(/prior_score_in_range/u);
    await expect(insert('current_class', '$2', ['class_9'])).rejects.toThrow(/current_class/u);
  });

  it('refuses half a scope, and more concepts than the syllabus has', async () => {
    await expect(insert('scope_taxonomy_version_id', '$2', [randomUUID()])).rejects.toThrow(/scope_whole/u);
    await expect(insert('scope_taxonomy_version_id, scope_node_ids, scope_concept_ids, scope_concept_total', '$2, $3, $4, $5', [randomUUID(), [randomUUID()], [randomUUID(), randomUUID()], 1])).rejects.toThrow(/scope_in_range/u);
  });
});
