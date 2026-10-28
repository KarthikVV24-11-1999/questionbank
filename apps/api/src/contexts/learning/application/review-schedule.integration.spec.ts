import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectValue } from '../../../testing/expect-result.js';
import { D002_THRESHOLDS, PLATFORM_THRESHOLDS_V2 } from '../../../testing/learning-thresholds.js';
import { createMasteryRuleSet } from '../domain/mastery-rule-set.js';
import type { MasteryEvidence } from '../domain/mastery-evidence.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';
import { PostgresConceptReader } from '../infrastructure/concept-reader.js';
import { PostgresReviewStore } from '../infrastructure/review.repository.js';
import { GetReviewPlanHandler } from './handlers/review-plan-handler.js';
import { RecordMasteryEvidenceHandler } from './handlers/record-evidence-handler.js';

/** The schedule is derived and stored with the evidence in one transaction (M7-47), and read back as a plan of concepts. */
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
  await database.pool.query('TRUNCATE learning.review_escalation, learning.review_schedule, learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.study_session, learning.mastery_evidence');
});

const record = (now = at(30)) => new RecordMasteryEvidenceHandler({ ledger: new PostgresLearningLedger(database.pool), ruleSets, clock: { now: () => new Date(now) }, identifiers: { next: () => randomUUID() } });

const response = (attempt: string, slot: string, concept: string, outcome: 'correct' | 'incorrect', occurredAt: string, taxonomy = TAXONOMY): MasteryEvidence => ({
  attemptRef: attempt,
  slotRef: slot,
  itemVersionRef: randomUUID(),
  conceptIdentityId: concept,
  taxonomyVersionId: taxonomy,
  outcome,
  difficultyEstimate: 'moderate',
  occurredAt,
  scoredAt: new Date(Date.parse(occurredAt) + 60_000).toISOString(),
});
/** Three responses on three items, all of one outcome, in one sitting on `day`. */
const sitting = (attempt: string, concept: string, day: number, outcome: 'correct' | 'incorrect', taxonomy = TAXONOMY) =>
  [0, 1, 2].map((i) => response(attempt, `${concept}-d${day}s${i}`, concept, outcome, at(day, i), taxonomy));

const schedules = async (learner: string) =>
  (await database.pool.query(`SELECT concept_identity_id, interval_days, consecutive_successes, lapse_count, due_at FROM learning.review_schedule WHERE learner_ref = $1 ORDER BY concept_identity_id`, [learner])).rows;

describe('the schedule a delivery leaves', () => {
  it('is one row for the concept however many items its responses were on, derived from all of them', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    expectValue(await record().handle({ learnerRef: learner, evidence: [...sitting(attempt, concept, 0, 'correct'), ...sitting(attempt, concept, 2, 'incorrect')] }, system));
    const rows = await schedules(learner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ concept_identity_id: concept, consecutive_successes: 0, lapse_count: 1 });
  });

  it('is rewritten as the next delivery arrives, and a replay of a delivery changes nothing', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const first = [...sitting(randomUUID(), concept, 0, 'correct')];
    expectValue(await record().handle({ learnerRef: learner, evidence: first }, system));
    const before = await schedules(learner);
    expectValue(await record().handle({ learnerRef: learner, evidence: first }, system));
    expect(await schedules(learner)).toEqual(before);
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), concept, 2, 'correct') }, system));
    const [row] = await schedules(learner);
    expect(row).toMatchObject({ consecutive_successes: 2, interval_days: 2 });
    expect(row.due_at.toISOString()).toBe(at(4, 2));
  });

  it('is corrected by a re-score: a sitting that failed and now passes is no longer a lapse', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    const failed = sitting(attempt, concept, 0, 'incorrect');
    expectValue(await record().handle({ learnerRef: learner, evidence: failed }, system));
    expect((await schedules(learner))[0]).toMatchObject({ lapse_count: 1 });
    const rescored = failed.map((e) => ({ ...e, outcome: 'correct' as const }));
    expectValue(await record().handle({ learnerRef: learner, evidence: rescored, attemptRef: attempt }, system));
    expect((await schedules(learner))[0]).toMatchObject({ lapse_count: 0, consecutive_successes: 1 });
  });

  it('is removed when a re-score leaves the concept with no evidence at all', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const other = randomUUID();
    const attempt = randomUUID();
    expectValue(await record().handle({ learnerRef: learner, evidence: [...sitting(attempt, concept, 0, 'correct'), ...sitting(attempt, other, 0, 'correct')] }, system));
    expect(await schedules(learner)).toHaveLength(2);
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(attempt, other, 0, 'correct'), attemptRef: attempt }, system));
    expect((await schedules(learner)).map((r) => r.concept_identity_id)).toEqual([other]);
  });

  it('is not made under a rule set published before the review values existed, and is made for another learner under the one that has them', async () => {
    const legacyTaxonomy = randomUUID();
    const legacy = createMasteryRuleSet({ ruleSetId: randomUUID(), taxonomyVersionId: legacyTaxonomy, versionNo: 1, thresholds: D002_THRESHOLDS });
    await ruleSets.append({ ruleSetId: randomUUID(), taxonomyVersionId: legacyTaxonomy, thresholds: expectValue(legacy).thresholds, thresholdsHash: expectValue(legacy).thresholdsHash, principal: system.principal, createdAt: new Date() });
    const learner = randomUUID();
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), randomUUID(), 0, 'correct', legacyTaxonomy) }, system));
    expect(await schedules(learner)).toEqual([]);
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), randomUUID(), 0, 'correct') }, system));
    expect(await schedules(learner)).toHaveLength(1);
  });
});

describe('the plan of what is due', () => {
  const plan = (now: string) => new GetReviewPlanHandler({ reviews: new PostgresReviewStore(database.pool), concepts: new PostgresConceptReader(database.pool), clock: { now: () => new Date(now) } });
  const asLearner = (id: string) => ({ principal: { kind: 'human' as const, id, roleContext: ['learner'] }, correlationId: 'c' });

  it('lists the concepts whose time has come, most overdue first, and not the ones whose time has not', async () => {
    const learner = randomUUID();
    const [early, late, notYet] = [randomUUID(), randomUUID(), randomUUID()];
    expectValue(await record().handle({ learnerRef: learner, evidence: [...sitting(randomUUID(), late, 3, 'correct'), ...sitting(randomUUID(), early, 0, 'correct'), ...sitting(randomUUID(), notYet, 9, 'correct')] }, system));
    const due = expectValue(await plan(at(5)).handle({}, asLearner(learner))).due;
    expect(due.map((d) => d.conceptIdentityId)).toEqual([early, late]);
    expect(due.every((d) => d.taxonomyVersionId === TAXONOMY)).toBe(true);
  });

  it('counts a concept as due at the very instant it is due', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), concept, 0, 'correct') }, system));
    const dueAt = at(1, 2);
    expect(expectValue(await plan(dueAt).handle({}, asLearner(learner))).due.map((d) => d.conceptIdentityId)).toEqual([concept]);
    expect(expectValue(await plan(new Date(Date.parse(dueAt) - 1).toISOString()).handle({}, asLearner(learner))).due).toEqual([]);
  });

  it('is the caller\'s own: another learner\'s due concepts are not in it', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    expectValue(await record().handle({ learnerRef: theirs, evidence: sitting(randomUUID(), randomUUID(), 0, 'correct') }, system));
    expect(expectValue(await plan(at(5)).handle({}, asLearner(mine))).due).toEqual([]);
  });

  it('is the learner\'s alone', async () => {
    const refused = await plan(at(5)).handle({}, system);
    expect(refused.ok === false && refused.error.kind).toBe('Authorization');
  });
});

describe('escalation to remediation (M7-48)', () => {
  const LIMIT = PLATFORM_THRESHOLDS_V2.review!.escalateAtLapses;
  const plan = (now = at(60)) => new GetReviewPlanHandler({ reviews: new PostgresReviewStore(database.pool), concepts: new PostgresConceptReader(database.pool), clock: { now: () => new Date(now) } });
  const asLearner = (id: string) => ({ principal: { kind: 'human' as const, id, roleContext: ['learner'] }, correlationId: 'c' });
  const escalationRows = async (learner: string) => (await database.pool.query(`SELECT concept_identity_id, lapse_count FROM learning.review_escalation WHERE learner_ref = $1`, [learner])).rows;
  /** The learner lapses on the concept `count` times, one delivery and one sitting each, a day apart starting on `from`; returns what each delivery escalated. */
  async function lapse(learner: string, concept: string, count: number, from = 0) {
    const escalatedBy: string[][] = [];
    for (let i = 0; i < count; i += 1) {
      const done = expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), concept, from + i * 2, 'incorrect') }, system));
      escalatedBy.push(done.escalated.map((e) => e.conceptIdentityId));
    }
    return escalatedBy;
  }

  it('escalates nothing one lapse below the threshold, and the concept stays in the plan to be repeated', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const escalatedBy = await lapse(learner, concept, LIMIT - 1);
    expect(escalatedBy.flat()).toEqual([]);
    expect(await escalationRows(learner)).toEqual([]);
    const view = expectValue(await plan().handle({}, asLearner(learner)));
    expect(view.escalated).toEqual([]);
    expect(view.due.map((d) => d.conceptIdentityId)).toEqual([concept]);
  });

  it('escalates at the threshold exactly once, in the delivery that crossed it, and takes the concept out of what is due', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const escalatedBy = await lapse(learner, concept, LIMIT);
    expect(escalatedBy.map((c) => c.length)).toEqual([...Array(LIMIT - 1).fill(0), 1]);
    expect(await escalationRows(learner)).toEqual([{ concept_identity_id: concept, lapse_count: LIMIT }]);
    const view = expectValue(await plan().handle({}, asLearner(learner)));
    expect(view.due).toEqual([]);
    expect(view.escalated).toHaveLength(1);
    expect(view.escalated[0]).toMatchObject({ conceptIdentityId: concept, taxonomyVersionId: TAXONOMY, lapseCount: LIMIT, remediation: { strategy: 'targeted', conceptIdentityId: concept, selected: true } });
  });

  it('does not escalate a concept that is already escalated, however much more it lapses', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    await lapse(learner, concept, LIMIT);
    const more = await lapse(learner, concept, 2, LIMIT * 2);
    expect(more.flat()).toEqual([]);
    expect(await escalationRows(learner)).toEqual([{ concept_identity_id: concept, lapse_count: LIMIT }]);
    expect(expectValue(await plan().handle({}, asLearner(learner))).escalated).toHaveLength(1);
  });

  it('writes nothing for a replay of the delivery that escalated it', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const sittings = Array.from({ length: LIMIT }, (_, i) => sitting(randomUUID(), concept, i * 2, 'incorrect'));
    for (const evidence of sittings) expectValue(await record().handle({ learnerRef: learner, evidence }, system));
    const replay = expectValue(await record().handle({ learnerRef: learner, evidence: sittings[LIMIT - 1]! }, system));
    expect(replay.escalated).toEqual([]);
    expect(await escalationRows(learner)).toHaveLength(1);
  });

  it('escalates the concept that lapsed and leaves another of the same learner alone', async () => {
    const learner = randomUUID();
    const [lapsing, steady] = [randomUUID(), randomUUID()];
    await lapse(learner, lapsing, LIMIT);
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), steady, 1, 'correct') }, system));
    expect((await escalationRows(learner)).map((r) => r.concept_identity_id)).toEqual([lapsing]);
  });

  it('is history: a row cannot be changed or removed', async () => {
    const learner = randomUUID();
    await lapse(learner, randomUUID(), LIMIT);
    await expect(database.pool.query('UPDATE learning.review_escalation SET lapse_count = 99')).rejects.toThrow(/learning_escalation_is_history/u);
    await expect(database.pool.query('DELETE FROM learning.review_escalation')).rejects.toThrow(/learning_escalation_is_history/u);
  });

  it('is the caller\'s own: another learner\'s escalation is not in the plan', async () => {
    const theirs = randomUUID();
    await lapse(theirs, randomUUID(), LIMIT);
    expect(expectValue(await plan().handle({}, asLearner(randomUUID()))).escalated).toEqual([]);
  });

  it('puts an escalated concept first in what a targeted run is about, ahead of a weaker one that has not escalated', async () => {
    const learner = randomUUID();
    const [escalated, weaker] = [randomUUID(), randomUUID()];
    // the escalated concept ends on a passing sitting, so it is developing rather than weak; the other has failed throughout and is weak
    await lapse(learner, escalated, LIMIT);
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), escalated, 20, 'correct') }, system));
    expectValue(await record().handle({ learnerRef: learner, evidence: sitting(randomUUID(), weaker, 21, 'incorrect') }, system));
    const reader = new PostgresConceptReader(database.pool);
    expect(expectValue(await reader.weakest(learner, TAXONOMY, 5))).toEqual([escalated, weaker]);
  });

  it('still offers an escalated concept once it has become strong, since the escalation stands', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    await lapse(learner, concept, LIMIT);
    await database.pool.query(`UPDATE learning.concept_state SET state = 'strong', raw_state = 'strong' WHERE learner_ref = $1`, [learner]);
    expect(expectValue(await new PostgresConceptReader(database.pool).weakest(learner, TAXONOMY, 5))).toEqual([concept]);
  });

  it('says which escalated concepts a targeted run would take: the run is bounded, and a finding beyond the bound says so', async () => {
    const learner = randomUUID();
    for (let i = 0; i < 6; i += 1) await lapse(learner, randomUUID(), LIMIT);
    const view = expectValue(await plan().handle({}, asLearner(learner)));
    expect(view.escalated).toHaveLength(6);
    expect(view.escalated.filter((f) => f.remediation.selected)).toHaveLength(5);
  });
});

