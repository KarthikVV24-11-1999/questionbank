import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { learningForAssessment } from '../public/composition.js';

/**
 * M7-28 — what a remediation run should be about leaves Learning as concept identities and nothing else, and only for the caller's own states.
 */
let database: TestDatabase;
const LEARNER = randomUUID();
const OTHER = randomUUID();
const TAXONOMY = randomUUID();
const concept = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const asLearner = (id: string) => ({ principal: { kind: 'human' as const, id, roleContext: ['learner'] }, correlationId: 'c' });

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
  await database.pool.query('TRUNCATE learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state');
});

async function state(learner: string, n: number, mastery: string, confidence: number, taxonomy = TAXONOMY): Promise<void> {
  const { rows } = await database.pool.query<{ rule_set_id: string }>('SELECT rule_set_id FROM learning.mastery_rule_set LIMIT 1');
  await database.pool.query(
    `INSERT INTO learning.concept_state (learner_ref, taxonomy_version_id, concept_identity_id, state, raw_state, confidence, base_confidence, low_confidence,
        evidence_count, distinct_item_count, distinct_session_count, last_evidence_at, decay_applied_at, rule_set_id)
     VALUES ($1, $2, $3, $4, $4, $5, $5, false, 8, 4, 2, now(), now(), $6)`,
    [learner, taxonomy, concept(n), mastery, confidence, rows[0]!.rule_set_id],
  );
}

describe('SuggestRemediationConcepts', () => {
  it('offers weak concepts before developing ones, least confident first, and no strong or unassessed one', async () => {
    await state(LEARNER, 1, 'developing', 0.3);
    await state(LEARNER, 2, 'weak', 0.6);
    await state(LEARNER, 3, 'weak', 0.2);
    await state(LEARNER, 4, 'strong', 0.9);
    await state(LEARNER, 5, 'unassessed', 0);
    const { remediationConcepts } = learningForAssessment({ pool: database.pool });
    const answer = expectValue(await remediationConcepts.handle({ taxonomyVersionId: TAXONOMY }, asLearner(LEARNER)));
    expect(answer.conceptIdentityIds).toEqual([concept(3), concept(2), concept(1)]);
  });

  it('says concepts and nothing else: the answer is one list of identifiers', async () => {
    await state(LEARNER, 1, 'weak', 0.2);
    const { remediationConcepts } = learningForAssessment({ pool: database.pool });
    const answer = expectValue(await remediationConcepts.handle({ taxonomyVersionId: TAXONOMY }, asLearner(LEARNER)));
    expect(Object.keys(answer)).toEqual(['conceptIdentityIds']);
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ conceptIdentityIds: [concept(1)] }));
  });

  it('is the caller\'s own states, in the taxonomy asked about, and bounded by the limit', async () => {
    await state(LEARNER, 1, 'weak', 0.1);
    await state(LEARNER, 2, 'weak', 0.2);
    await state(OTHER, 3, 'weak', 0.0);
    await state(LEARNER, 4, 'weak', 0.0, randomUUID());
    const { remediationConcepts } = learningForAssessment({ pool: database.pool });
    const mine = expectValue(await remediationConcepts.handle({ taxonomyVersionId: TAXONOMY, limit: 1 }, asLearner(LEARNER)));
    expect(mine.conceptIdentityIds).toEqual([concept(1)]);
  });

  it('is a learner\'s alone, and refuses a malformed query', async () => {
    const { remediationConcepts } = learningForAssessment({ pool: database.pool });
    const operator = { principal: { kind: 'human' as const, id: LEARNER, roleContext: ['content_ops'] }, correlationId: 'c' };
    expect(expectError(await remediationConcepts.handle({ taxonomyVersionId: TAXONOMY }, operator)).kind).toBe('Authorization');
    for (const query of [{ taxonomyVersionId: 'nope' }, { taxonomyVersionId: TAXONOMY, limit: 0 }, { taxonomyVersionId: TAXONOMY, limit: 21 }]) {
      expect(expectError(await remediationConcepts.handle(query, asLearner(LEARNER))).code).toBe('REMEDIATION_QUERY_INVALID');
    }
  });
});
