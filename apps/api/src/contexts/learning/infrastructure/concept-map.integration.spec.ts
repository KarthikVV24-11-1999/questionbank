import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectValue } from '../../../testing/expect-result.js';
import { PostgresConceptMapStore } from './concept-map.repository.js';

/** The learner's concept map as stored (M8-28): the caller's own rows, the responses a state is made of, and none that a re-score withdrew. */
let database: TestDatabase;
let store: PostgresConceptMapStore;
const LEARNER = randomUUID();
const OTHER = randomUUID();
const TAXONOMY = randomUUID();
const concept = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  store = new PostgresConceptMapStore(database.pool);
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  await database.pool.query('TRUNCATE learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.mastery_evidence CASCADE');
});

async function response(learner: string, n: number, minute: number, outcome: 'correct' | 'incorrect', taxonomy = TAXONOMY): Promise<string> {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO learning.mastery_evidence (evidence_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, outcome, difficulty_estimate, occurred_at, scored_at, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'moderate', $9, $9, $9)`,
    [id, learner, randomUUID(), `slot-${id}`, randomUUID(), concept(n), taxonomy, outcome, new Date(Date.UTC(2026, 10, 1, 9, minute))],
  );
  return id;
}

async function state(learner: string, n: number, mastery: string, taxonomy = TAXONOMY): Promise<void> {
  const { rows } = await database.pool.query<{ rule_set_id: string }>('SELECT rule_set_id FROM learning.mastery_rule_set LIMIT 1');
  await database.pool.query(
    `INSERT INTO learning.concept_state (learner_ref, taxonomy_version_id, concept_identity_id, state, raw_state, confidence, base_confidence, low_confidence,
        evidence_count, distinct_item_count, distinct_session_count, last_evidence_at, decay_applied_at, rule_set_id, difficulty_band_demonstrated)
     VALUES ($1, $2, $3, $4, $4, 0.5, 0.75, true, 3, 3, 1, '2026-11-01T09:30:00Z', '2026-11-01T10:00:00Z', $5, 'moderate')`,
    [learner, taxonomy, concept(n), mastery, rows[0]!.rule_set_id],
  );
}

describe('the states', () => {
  it('reads the caller\'s states for one taxonomy version, as stored and in the order of the concepts, each with the responses that make it', async () => {
    const [a, b] = [await response(LEARNER, 2, 1, 'correct'), await response(LEARNER, 2, 2, 'incorrect')];
    await state(LEARNER, 2, 'weak');
    await state(LEARNER, 1, 'strong');
    const map = expectValue(await store.states(LEARNER, TAXONOMY));
    expect(map).toMatchObject({ learnerRef: LEARNER, taxonomyVersionId: TAXONOMY, lastRecomputedAt: '2026-11-01T10:00:00.000Z' });
    expect(map.conceptStates.map((s) => s.conceptIdentityId)).toEqual([concept(1), concept(2)]);
    const weak = map.conceptStates[1]!;
    expect(weak).toMatchObject({ state: 'weak', rawState: 'weak', confidence: 0.5, baseConfidence: 0.75, lowConfidence: true, evidenceCount: 3, distinctItemCount: 3, distinctSessionCount: 1, lastEvidenceAt: '2026-11-01T09:30:00.000Z', difficultyBandDemonstrated: 'moderate', decayAppliedAt: '2026-11-01T10:00:00.000Z' });
    expect(weak.evidenceIds).toEqual([a, b]);
    expect(map.conceptStates[0]!.evidenceIds).toEqual([]);
  });

  it('is the caller\'s and the version\'s alone', async () => {
    await state(LEARNER, 1, 'weak');
    await state(OTHER, 2, 'weak');
    await state(LEARNER, 3, 'weak', randomUUID());
    const map = expectValue(await store.states(LEARNER, TAXONOMY));
    expect(map.conceptStates.map((s) => s.conceptIdentityId)).toEqual([concept(1)]);
  });

  it('is an empty map, not an error, for a learner with no states', async () => {
    const map = expectValue(await store.states(LEARNER, TAXONOMY));
    expect(map.conceptStates).toEqual([]);
    expect(map.lastRecomputedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('does not count a response a re-score withdrew, and counts one it corrected at what it now is', async () => {
    const kept = await response(LEARNER, 1, 1, 'correct');
    const withdrawn = await response(LEARNER, 1, 2, 'correct');
    const corrected = await response(LEARNER, 1, 3, 'correct');
    await state(LEARNER, 1, 'weak');
    await database.pool.query("INSERT INTO learning.evidence_correction (evidence_id, outcome, recorded_at) VALUES ($1, 'withdrawn', now()), ($2, 'incorrect', now())", [withdrawn, corrected]);
    const map = expectValue(await store.states(LEARNER, TAXONOMY));
    expect(map.conceptStates[0]!.evidenceIds).toEqual([kept, corrected]);
  });

  it('says the store is unavailable when it cannot be read, and nothing of the store', async () => {
    const closed = new PostgresConceptMapStore({ query: async () => { throw new Error('connection lost at host db-7'); } } as never);
    const failed = await closed.states(LEARNER, TAXONOMY);
    expect(failed).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'LEARNING_STORE_UNAVAILABLE' } });
    expect(JSON.stringify(failed)).not.toContain('db-7');
    expect(await closed.responses(LEARNER, TAXONOMY, concept(1), { limit: 10, offset: 0 })).toMatchObject({ ok: false, error: { code: 'LEARNING_STORE_UNAVAILABLE' } });
  });
});

describe('the responses behind one state', () => {
  it('gives them newest first with how many there are, a page at a time', async () => {
    const ids: string[] = [];
    for (let minute = 0; minute < 5; minute += 1) ids.push(await response(LEARNER, 1, minute, minute % 2 === 0 ? 'correct' : 'incorrect'));
    const first = expectValue(await store.responses(LEARNER, TAXONOMY, concept(1), { limit: 2, offset: 0 }));
    expect(first.total).toBe(5);
    expect(first.responses.map((r) => r.evidenceId)).toEqual([ids[4], ids[3]]);
    expect(first.responses[0]).toMatchObject({ outcome: 'correct', difficultyEstimate: 'moderate', occurredAt: '2026-11-01T09:04:00.000Z' });
    expect(first.responses[0]!.attemptRef).toMatch(/^[0-9a-f-]{36}$/u);
    const last = expectValue(await store.responses(LEARNER, TAXONOMY, concept(1), { limit: 2, offset: 4 }));
    expect(last.responses.map((r) => r.evidenceId)).toEqual([ids[0]]);
    expect(last.total).toBe(5);
  });

  it('still says how many there are when the page is past the end, and none when there never were any', async () => {
    await response(LEARNER, 1, 1, 'correct');
    expect(expectValue(await store.responses(LEARNER, TAXONOMY, concept(1), { limit: 10, offset: 10 }))).toEqual({ total: 1, responses: [] });
    expect(expectValue(await store.responses(LEARNER, TAXONOMY, concept(9), { limit: 10, offset: 0 }))).toEqual({ total: 0, responses: [] });
    expect(expectValue(await store.responses(LEARNER, TAXONOMY, concept(9), { limit: 10, offset: 10 }))).toEqual({ total: 0, responses: [] });
  });

  it('shows a corrected outcome and leaves out a withdrawn response, in the count as well', async () => {
    const a = await response(LEARNER, 1, 1, 'correct');
    const b = await response(LEARNER, 1, 2, 'correct');
    await database.pool.query("INSERT INTO learning.evidence_correction (evidence_id, outcome, recorded_at) VALUES ($1, 'incorrect', now()), ($2, 'withdrawn', now())", [a, b]);
    const page = expectValue(await store.responses(LEARNER, TAXONOMY, concept(1), { limit: 10, offset: 0 }));
    expect(page.total).toBe(1);
    expect(page.responses).toMatchObject([{ evidenceId: a, outcome: 'incorrect' }]);
  });

  it('is the caller\'s own, for the concept and the version asked', async () => {
    await response(LEARNER, 1, 1, 'correct');
    await response(OTHER, 1, 2, 'correct');
    await response(LEARNER, 1, 3, 'correct', randomUUID());
    await response(LEARNER, 2, 4, 'correct');
    expect(expectValue(await store.responses(LEARNER, TAXONOMY, concept(1), { limit: 10, offset: 0 })).total).toBe(1);
  });
});
