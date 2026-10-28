import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import type { MasteryEvidence } from '../domain/mastery-evidence.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';
import { RecordMasteryEvidenceHandler } from './handlers/record-evidence-handler.js';

/**
 * A re-score reaches the learner (D72, M7-40). Evidence is history and a transition is history, so a correction is a row beside the one it corrects, and a
 * promotion granted on an outcome that changed is revoked beside the transition and not removed. Each spec asserts both halves: what a reader sees now, and
 * what is still on record.
 */
let database: TestDatabase;
let ruleSets: PostgresMasteryRuleSetRepository;

const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: ['system'] }, correlationId: 'c' };
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();
const TAXONOMY = randomUUID();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  ruleSets = new PostgresMasteryRuleSetRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.study_session, learning.mastery_evidence');
});

const handlerOn = (now = at(5)) =>
  new RecordMasteryEvidenceHandler({ ledger: new PostgresLearningLedger(database.pool), ruleSets, clock: { now: () => new Date(now) }, identifiers: { next: () => randomUUID() } });

const response = (attempt: string, slot: string, concept: string, outcome: 'correct' | 'incorrect', occurredAt: string, item = `${slot}-${attempt}`): MasteryEvidence => ({
  attemptRef: attempt,
  slotRef: slot,
  itemVersionRef: randomUUID(),
  conceptIdentityId: concept,
  taxonomyVersionId: TAXONOMY,
  outcome,
  difficultyEstimate: 'moderate',
  occurredAt,
  scoredAt: new Date(Date.parse(occurredAt) + 60_000).toISOString(),
});

/** Four wrong answers, then eight right ones over days 1 and 2 (the qualification), then two right ones two days later in another sitting (the verification). */
function gain(concept: string, qualifying: string) {
  const weak = Array.from({ length: 4 }, (_, i) => response(randomUUID(), `w${i}`, concept, 'incorrect', at(0, i * 5)));
  const earned = (outcomes: readonly ('correct' | 'incorrect')[]) => outcomes.map((o, i) => response(qualifying, `q${i}`, concept, o, i < 4 ? at(1, i * 5) : at(2, i * 5)));
  const later = Array.from({ length: 2 }, (_, i) => response(randomUUID(), `v${i}`, concept, 'correct', at(0, (2 * 24 + 60) * 60 + i * 5)));
  return { weak, earned, later };
}
const ALL_RIGHT = Array.from({ length: 8 }, () => 'correct' as const);

const activeNorthStar = async (learner: string) =>
  (await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM learning.mastery_transition t
      WHERE learner_ref = $1 AND from_state = 'weak' AND to_state = 'strong' AND verified_at IS NOT NULL AND NOT is_regression
        AND NOT EXISTS (SELECT 1 FROM learning.transition_revocation r WHERE r.transition_id = t.transition_id)`,
    [learner],
  )).rows[0]!.n;
const stateOf = async (learner: string, concept: string) =>
  (await database.pool.query<{ state: string; evidence_count: number }>('SELECT state, evidence_count FROM learning.concept_state WHERE learner_ref = $1 AND concept_identity_id = $2', [learner, concept])).rows[0];
const count = async (sql: string, params: unknown[] = []) => (await database.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

async function learnerWithVerifiedGain() {
  const learner = randomUUID();
  const concept = randomUUID();
  const qualifying = randomUUID();
  const run = gain(concept, qualifying);
  expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...run.weak, ...run.earned(ALL_RIGHT)] }, system));
  expectValue(await handlerOn(at(30)).handle({ learnerRef: learner, evidence: run.later }, system));
  return { learner, concept, qualifying, run };
}

describe('a mastery gain qualified on a corrected outcome does not survive the correction', () => {
  it('revokes the promotion beside the transition, leaves the concept no longer strong, and keeps the evidence it was made on as it was', async () => {
    const { learner, concept, qualifying, run } = await learnerWithVerifiedGain();
    expect(await activeNorthStar(learner)).toBe(1);
    expect((await stateOf(learner, concept))?.state).toBe('strong');
    const [gainRow] = (await database.pool.query<{ transition_id: string }>('SELECT transition_id FROM learning.mastery_transition WHERE learner_ref = $1 ORDER BY transition_seq', [learner])).rows;

    // the re-score: half of what the learner was credited with was wrong
    const corrected = expectValue(await handlerOn(at(40)).handle({ learnerRef: learner, attemptRef: qualifying, evidence: run.earned(['correct', 'incorrect', 'correct', 'incorrect', 'correct', 'incorrect', 'correct', 'incorrect']) }, system));

    expect(corrected).toMatchObject({ recorded: 0, corrected: 4 });
    expect(corrected.revoked).toContain(gainRow!.transition_id);
    expect(await activeNorthStar(learner)).toBe(0);
    expect((await stateOf(learner, concept))?.state).not.toBe('strong');
    // history: the transition, the links to its responses and the original outcomes are all still there
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_transition WHERE transition_id = $1', [gainRow!.transition_id])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM learning.transition_revocation WHERE transition_id = $1', [gainRow!.transition_id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM learning.mastery_evidence WHERE attempt_ref = $1 AND outcome = 'correct'`, [qualifying])).toBe(8);
    expect(await count('SELECT count(*)::int AS n FROM learning.evidence_correction')).toBe(4);
  });

  it('is a no-op to hear the same correction twice, and a third score that agrees with the first corrects it back', async () => {
    const { learner, concept, qualifying, run } = await learnerWithVerifiedGain();
    const wrong = run.earned(['correct', 'incorrect', 'correct', 'incorrect', 'correct', 'incorrect', 'correct', 'incorrect']);
    expectValue(await handlerOn(at(40)).handle({ learnerRef: learner, attemptRef: qualifying, evidence: wrong }, system));

    const again = expectValue(await handlerOn(at(41)).handle({ learnerRef: learner, attemptRef: qualifying, evidence: wrong }, system));
    expect(again).toMatchObject({ corrected: 0, recorded: 0 });
    expect(await count('SELECT count(*)::int AS n FROM learning.evidence_correction')).toBe(4);

    // a second re-score restores the original outcomes: the evidence reads as first recorded and the gain is earned again, as a transition of its own
    const restored = expectValue(await handlerOn(at(42)).handle({ learnerRef: learner, attemptRef: qualifying, evidence: run.earned(ALL_RIGHT) }, system));
    expect(restored.corrected).toBe(4);
    expect((await stateOf(learner, concept))?.state).toBe('strong');
    expect(await activeNorthStar(learner)).toBe(1);
  });

  it('withdraws a response the score no longer counts, and a concept left with nothing is unassessed rather than still strong', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    const run = gain(concept, attempt);
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run.earned(ALL_RIGHT) }, system));
    expect((await stateOf(learner, concept))?.state).toBe('strong');

    // a rule change drops every question: the attempt now has no evidence at all
    const dropped = expectValue(await handlerOn(at(40)).handle({ learnerRef: learner, attemptRef: attempt, evidence: [] }, system));
    expect(dropped.corrected).toBe(8);
    expect(await stateOf(learner, concept)).toBeUndefined();
    expect(await count(`SELECT count(*)::int AS n FROM learning.evidence_correction WHERE outcome = 'withdrawn'`)).toBe(8);
    expect(await count('SELECT count(*)::int AS n FROM learning.transition_revocation')).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_evidence WHERE attempt_ref = $1', [attempt])).toBe(8);
  });
});

describe('a correction that cannot be decided writes nothing', () => {
  it('aborts with the cause, and leaves the evidence uncorrected, when the rule set for a taxonomy a withdrawal touches cannot be read', async () => {
    const learner = randomUUID();
    const attempt = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: gain(concept, attempt).earned(ALL_RIGHT) }, system));
    const broken = new RecordMasteryEvidenceHandler({
      ledger: new PostgresLearningLedger(database.pool),
      ruleSets: { currentFor: async () => ({ ok: false, error: { kind: 'NotFound', code: 'NO_RULE_SET', message: 'none' } }), byId: async () => ({ ok: false, error: { kind: 'NotFound', code: 'NO_RULE_SET', message: 'none' } }) } as never,
      clock: { now: () => new Date(at(40)) },
      identifiers: { next: () => randomUUID() },
    });
    expect(expectError(await broken.handle({ learnerRef: learner, attemptRef: attempt, evidence: [] }, system)).code).toBe('NO_RULE_SET');
    expect(await count('SELECT count(*)::int AS n FROM learning.evidence_correction')).toBe(0);
  });
});

describe('a correction touches only what it corrected', () => {
  it('leaves a gain alone when the response corrected came after it, and another concept alone entirely', async () => {
    const { learner, concept } = await learnerWithVerifiedGain();
    const other = randomUUID();
    const otherAttempt = randomUUID();
    const lateAttempt = randomUUID();
    expectValue(await handlerOn(at(50)).handle({ learnerRef: learner, evidence: [response(otherAttempt, 's0', other, 'correct', at(6)), response(lateAttempt, 's0', concept, 'incorrect', at(9))] }, system));
    const before = (await database.pool.query<{ transition_id: string }>('SELECT transition_id FROM learning.mastery_transition WHERE learner_ref = $1 AND concept_identity_id = $2 ORDER BY transition_seq', [learner, concept])).rows;
    const gainId = before[0]!.transition_id;

    const corrected = expectValue(await handlerOn(at(60)).handle({ learnerRef: learner, attemptRef: lateAttempt, evidence: [response(lateAttempt, 's0', concept, 'correct', at(9))] }, system));

    expect(corrected.corrected).toBe(1);
    expect(corrected.revoked).not.toContain(gainId);
    expect(await activeNorthStar(learner)).toBe(1);
    expect((await stateOf(learner, other))?.state).toBe('developing');
  });
});
