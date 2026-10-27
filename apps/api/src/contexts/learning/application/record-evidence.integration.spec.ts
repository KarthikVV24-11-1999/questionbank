import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAuditRecorder } from '../../../platform/persistence/audit-recorder.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { thresholdsWith } from '../../../testing/learning-thresholds.js';
import { deriveConceptState, type ConceptEvidence } from '../domain/concept-state.js';
import type { DifficultyEstimate, EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';
import { PublishMasteryRuleSetHandler } from './handlers/rule-set-handlers.js';
import { RecordMasteryEvidenceHandler } from './handlers/record-evidence-handler.js';

let database: TestDatabase;
let ruleSets: PostgresMasteryRuleSetRepository;

const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: ['system'] }, correlationId: 'c' };
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();

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
  await database.pool.query('TRUNCATE learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.study_session, learning.mastery_evidence');
});

const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const handlerOn = (pool: Pool = database.pool, now = at(5)) =>
  new RecordMasteryEvidenceHandler({ ledger: new PostgresLearningLedger(pool), ruleSets, clock: clockAt(now), identifiers: { next: () => randomUUID() } });

const TAXONOMY = randomUUID();
interface Given {
  readonly attempt: string;
  readonly slot: string;
  readonly concept: string;
  readonly outcome?: EvidenceOutcome;
  readonly occurredAt: string;
  readonly item?: string;
  readonly band?: DifficultyEstimate;
  readonly taxonomy?: string;
}
const evidence = (g: Given): MasteryEvidence => ({
  attemptRef: g.attempt,
  slotRef: g.slot,
  itemVersionRef: g.item ?? randomUUID(),
  conceptIdentityId: g.concept,
  taxonomyVersionId: g.taxonomy ?? TAXONOMY,
  outcome: g.outcome ?? 'correct',
  difficultyEstimate: g.band ?? 'moderate',
  occurredAt: g.occurredAt,
  // a response never follows the score that counted it: scored a minute after it was given, unless a spec says otherwise
  scoredAt: new Date(Date.parse(g.occurredAt) + 60_000).toISOString(),
});

/** Eight correct responses on eight items, four on day 0 and four on day 1 : D-002's promotion. */
function strongRun(concept: string, attempt: string = randomUUID()): MasteryEvidence[] {
  return Array.from({ length: 8 }, (_, i) => evidence({ attempt, slot: `s${i + 1}`, concept, occurredAt: i < 4 ? at(0, i * 5) : at(1, i * 5) }));
}

const count = async (sql: string, params: unknown[] = []) => (await database.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('recording a learner\'s evidence', () => {
  it('stores each response durably, places it in a sitting, and derives the concept state from the rows', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const done = expectValue(await handlerOn().handle({ learnerRef: learner, evidence: strongRun(concept) }, system));
    expect(done).toMatchObject({ recorded: 8, replayed: 0 });
    expect(done.maps).toHaveLength(1);
    expect(done.maps[0]!.conceptStates[0]).toMatchObject({ conceptIdentityId: concept, state: 'strong', evidenceCount: 8, distinctSessionCount: 2 });

    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_evidence WHERE learner_ref = $1 AND study_session_id IS NOT NULL', [learner])).toBe(8);
    // one pausable attempt paused for a day is two sittings, and every response is in one of them
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(2);
    const stored = (await database.pool.query('SELECT state, raw_state, evidence_count, distinct_session_count, rule_set_id FROM learning.concept_state WHERE learner_ref = $1', [learner])).rows;
    expect(stored).toEqual([{ state: 'strong', raw_state: 'strong', evidence_count: 8, distinct_session_count: 2, rule_set_id: '00000000-0000-4000-8000-0000000000d2' }]);
  });

  it('makes every state traceable: the stored state is what the stored responses derive, and it names exactly those responses', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: strongRun(concept) }, system));
    const rows = (await database.pool.query(
      `SELECT evidence_id, item_version_ref, outcome, difficulty_estimate, occurred_at, study_session_id FROM learning.mastery_evidence WHERE learner_ref = $1 AND concept_identity_id = $2`,
      [learner, concept],
    )).rows;
    const asConcept: ConceptEvidence[] = rows.map((r) => ({ evidenceId: r.evidence_id, itemVersionRef: r.item_version_ref, outcome: r.outcome, difficultyEstimate: r.difficulty_estimate, occurredAt: r.occurred_at.toISOString(), sessionId: r.study_session_id }));
    const seeded = expectValue(await ruleSets.currentFor(TAXONOMY));
    const rebuilt = deriveConceptState(concept, asConcept, seeded.thresholds, at(5));
    const stored = (await database.pool.query('SELECT state, confidence, evidence_count, distinct_item_count, distinct_session_count, difficulty_band_demonstrated FROM learning.concept_state WHERE learner_ref = $1', [learner])).rows[0];
    expect(stored).toMatchObject({ state: rebuilt.state, evidence_count: rebuilt.evidenceCount, distinct_item_count: rebuilt.distinctItemCount, distinct_session_count: rebuilt.distinctSessionCount, difficulty_band_demonstrated: rebuilt.difficultyBandDemonstrated });
    expect(stored.confidence).toBeCloseTo(rebuilt.confidence, 9);
    expect([...rebuilt.evidenceIds].sort()).toEqual(rows.map((r) => r.evidence_id).sort());
    expect(rebuilt.evidenceIds).toHaveLength(stored.evidence_count);
  });

  it('does nothing for a delivery it has seen: the same responses again store nothing, place nothing and recompute nothing', async () => {
    const learner = randomUUID();
    const run = strongRun(randomUUID());
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run }, system));
    const before = (await database.pool.query('SELECT decay_applied_at, evidence_count FROM learning.concept_state WHERE learner_ref = $1', [learner])).rows;

    const again = expectValue(await handlerOn(database.pool, at(9)).handle({ learnerRef: learner, evidence: run }, system));
    expect(again).toMatchObject({ recorded: 0, replayed: 8, maps: [] });
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_evidence WHERE learner_ref = $1', [learner])).toBe(8);
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(2);
    // the state was not recomputed: it is still derived as of the first delivery, not the later one
    expect((await database.pool.query('SELECT decay_applied_at, evidence_count FROM learning.concept_state WHERE learner_ref = $1', [learner])).rows).toEqual(before);
  });

  it('counts only the responses that are new in a delivery that overlaps an earlier one', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const run = strongRun(concept);
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run.slice(0, 5) }, system));
    const overlapping = expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run }, system));
    expect(overlapping).toMatchObject({ recorded: 3, replayed: 5 });
    expect(overlapping.maps[0]!.conceptStates[0]!.evidenceCount).toBe(8);
  });

  it('bridges two sittings into one when a late response falls between them, and reassigns the responses of the one it absorbed', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [evidence({ attempt, slot: 'a', concept, occurredAt: at(0, 0) }), evidence({ attempt, slot: 'b', concept, occurredAt: at(0, 50) })] }, system));
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(2);

    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [evidence({ attempt, slot: 'c', concept, occurredAt: at(0, 25) })] }, system));
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(1);
    expect(await count('SELECT count(DISTINCT study_session_id)::int AS n FROM learning.mastery_evidence WHERE learner_ref = $1', [learner])).toBe(1);
    const session = (await database.pool.query('SELECT started_at, ended_at FROM learning.study_session WHERE learner_ref = $1', [learner])).rows[0];
    expect([session.started_at.toISOString(), session.ended_at.toISOString()]).toEqual([at(0, 0), at(0, 50)]);
  });

  it('recomputes only the taxonomy versions a delivery changed: one whose responses were stored already is left alone', async () => {
    const learner = randomUUID();
    const [conceptA, conceptB, taxonomyB] = [randomUUID(), randomUUID(), randomUUID()];
    const attempt = randomUUID();
    const first = [evidence({ attempt, slot: 'a', concept: conceptA, occurredAt: at(0, 0) }), evidence({ attempt, slot: 'b', concept: conceptB, taxonomy: taxonomyB, occurredAt: at(0, 1) })];
    expect(expectValue(await handlerOn().handle({ learnerRef: learner, evidence: first }, system)).maps.map((m) => m.taxonomyVersionId).sort()).toEqual([TAXONOMY, taxonomyB].sort());
    // a second delivery repeats the first taxonomy's response and adds one under the other
    const second = [first[0]!, evidence({ attempt, slot: 'c', concept: conceptB, taxonomy: taxonomyB, occurredAt: at(0, 2) })];
    const done = expectValue(await handlerOn().handle({ learnerRef: learner, evidence: second }, system));
    expect(done).toMatchObject({ recorded: 1, replayed: 1 });
    expect(done.maps.map((m) => m.taxonomyVersionId)).toEqual([taxonomyB]);
  });

  it('keeps one learner\'s sittings and states out of another\'s', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: a, evidence: strongRun(concept) }, system));
    const second = expectValue(await handlerOn().handle({ learnerRef: b, evidence: [evidence({ attempt: randomUUID(), slot: 's1', concept, occurredAt: at(0, 3) })] }, system));
    // the same minute, the same concept: B has one response and one sitting of their own
    expect(second.maps[0]!.conceptStates[0]).toMatchObject({ evidenceCount: 1, state: 'developing', distinctSessionCount: 1 });
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [b])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM learning.concept_state WHERE learner_ref = $1', [b])).toBe(1);
    expect(await count('SELECT evidence_count AS n FROM learning.concept_state WHERE learner_ref = $1', [a])).toBe(8);
  });

  it('decides under the rule set published for the taxonomy, and pins the version it used', async () => {
    const taxonomy = randomUUID();
    const publish = new PublishMasteryRuleSetHandler({ ruleSets, clock: clockAt(at(0)), identifiers: { next: () => randomUUID() }, audit: new PostgresAuditRecorder(database.pool) as never });
    const wide = expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: thresholdsWith({ session: { idleGapMinutes: 24 * 60 } }) }, { principal: { kind: 'human', id: randomUUID(), roleContext: ['admin'] }, correlationId: 'c', stepUpSatisfied: true }));
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    const given = [evidence({ attempt, slot: 'a', concept, taxonomy, occurredAt: at(0, 0) }), evidence({ attempt, slot: 'b', concept, taxonomy, occurredAt: at(0, 300) })];
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: given }, system));
    // five hours apart is two sittings at the default gap and one at a day
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(1);
    expect((await database.pool.query('SELECT rule_set_id FROM learning.concept_state WHERE learner_ref = $1', [learner])).rows[0].rule_set_id).toBe(wide.ruleSetId);
  });
});

describe('a delivery is one transaction', () => {
  it('commits no evidence, no sitting and no state when the last write fails, and the same delivery then goes through whole', async () => {
    const learner = randomUUID();
    const run = strongRun(randomUUID());
    const refusing = new Proxy(database.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect();
            const original = client.query;
            const release = client.release.bind(client);
            client.query = ((text: unknown, ...rest: unknown[]) =>
              typeof text === 'string' && /INSERT INTO learning\.concept_state/u.test(text)
                ? Promise.reject(new Error('injected: the state write is refused'))
                : (original as (...a: unknown[]) => unknown).call(client, text, ...rest)) as never;
            client.release = ((...args: unknown[]) => {
              client.query = original;
              return (release as (...a: unknown[]) => void)(...args);
            }) as never;
            return client;
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Pool;

    const failed = expectError(await handlerOn(refusing).handle({ learnerRef: learner, evidence: run }, system));
    expect(failed.code).toBe('LEDGER_UNAVAILABLE');
    for (const table of ['mastery_evidence', 'study_session', 'concept_state']) {
      expect(await count(`SELECT count(*)::int AS n FROM learning.${table}`), table).toBe(0);
    }
    // nothing was left in the way: the fault did not outlive its connection
    expect(expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run }, system))).toMatchObject({ recorded: 8 });
  });

  it('reports a store it cannot reach as unavailable and says nothing of the driver', async () => {
    const { Pool: PgPool } = await import('pg');
    const unreachable = new PgPool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    unreachable.on('error', () => undefined);
    const result = expectError(await handlerOn(unreachable).handle({ learnerRef: randomUUID(), evidence: strongRun(randomUUID()) }, system));
    expect(result.code).toBe('LEDGER_UNAVAILABLE');
    expect(result.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/u);
    await unreachable.end().catch(() => undefined);
  });
});

describe('evidence is history', () => {
  it('refuses an edit to anything but the sitting, and any delete, at the database', async () => {
    const learner = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: strongRun(randomUUID()) }, system));
    for (const statement of [
      `UPDATE learning.mastery_evidence SET outcome = 'incorrect' WHERE learner_ref = '${learner}'`,
      `UPDATE learning.mastery_evidence SET occurred_at = occurred_at + interval '1 day', scored_at = scored_at + interval '1 day' WHERE learner_ref = '${learner}'`,
      `DELETE FROM learning.mastery_evidence WHERE learner_ref = '${learner}'`,
    ]) {
      await expect(database.pool.query(statement)).rejects.toThrow(/learning_mastery_evidence_is_history/u);
    }
    // the sitting is the one thing that may move
    await expect(database.pool.query(`UPDATE learning.mastery_evidence SET study_session_id = study_session_id WHERE learner_ref = '${learner}'`)).resolves.toBeDefined();
  });

  it('refuses a response dated after the score that counted it, and a second response for one slot of one attempt', async () => {
    const learner = randomUUID();
    const insert = (slot: string, occurredAt: string, scoredAt: string) =>
      database.pool.query(
        `INSERT INTO learning.mastery_evidence (evidence_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, outcome, difficulty_estimate, occurred_at, scored_at, recorded_at)
         VALUES ($1, $2, $3, $4, $1, $1, $1, 'correct', 'moderate', $5, $6, now())`,
        [randomUUID(), learner, '00000000-0000-4000-8000-0000000000a1', slot, occurredAt, scoredAt],
      );
    await expect(insert('x', at(2), at(1))).rejects.toThrow(/mastery_evidence_response_precedes_score/u);
    await insert('y', at(1), at(2));
    await expect(insert('y', at(1), at(2))).rejects.toThrow(/mastery_evidence_one_per_slot/u);
  });
});

describe('who may record', () => {
  it('is the system\'s alone', async () => {
    const handler = handlerOn();
    expect(handler.policy.allowedRoles).toEqual(['system']);
    for (const roles of [['learner'], ['admin'], ['content_ops']]) {
      expect(expectError(await handler.handle({ learnerRef: randomUUID(), evidence: [] }, { principal: { kind: 'human', id: randomUUID(), roleContext: roles }, correlationId: 'c' })).code).toBe('NOT_PERMITTED');
    }
  });

  it('passes a rule-set failure through without opening a transaction', async () => {
    const empty = new RecordMasteryEvidenceHandler({
      ledger: { inTransaction: async () => { throw new Error('must not open'); } } as never,
      ruleSets: { currentFor: async () => ({ ok: false, error: { kind: 'NotFound', code: 'NO_RULE_SET', message: 'none' } }) } as never,
      clock: clockAt(at(0)),
      identifiers: { next: () => randomUUID() },
    });
    expect(expectError(await empty.handle({ learnerRef: randomUUID(), evidence: strongRun(randomUUID()) }, system)).code).toBe('NO_RULE_SET');
  });
});


/**
 * A learner who was weak, qualified, and is then asked again. `weak` is four wrong answers on day 0; the qualification is eight right ones over days 1 and 2,
 * which D-002 grants at the seventh; and what verifies it must come at least forty-eight hours after that, in another sitting, on other items.
 */
const history = {
  weak: (concept: string, attempt = randomUUID()) => Array.from({ length: 4 }, (_, i) => evidence({ attempt, slot: `w${i}`, concept, outcome: 'incorrect', occurredAt: at(0, i * 5) })),
  qualifying: (concept: string, attempt = randomUUID()) => Array.from({ length: 8 }, (_, i) => evidence({ attempt, slot: `q${i}`, concept, occurredAt: i < 4 ? at(1, i * 5) : at(2, i * 5) })),
  later: (concept: string, items: number, atHours: number, attempt = randomUUID()) => Array.from({ length: items }, (_, i) => evidence({ attempt, slot: `v${i}`, concept, occurredAt: at(0, atHours * 60 + i * 5) })),
};
const transitions = async (learner: string) =>
  (await database.pool.query(`SELECT from_state, to_state, is_regression, verified_at, rule_set_id, occurred_at FROM learning.mastery_transition WHERE learner_ref = $1 ORDER BY transition_seq`, [learner])).rows;
const northStar = async (learner: string) =>
  count(`SELECT count(*)::int AS n FROM learning.mastery_transition WHERE learner_ref = $1 AND from_state = 'weak' AND to_state = 'strong' AND verified_at IS NOT NULL AND NOT is_regression`, [learner]);

describe('a weak concept becomes strong, and the gain is verified', () => {
  it('records the qualification at once from weak with the responses behind it, and counts nothing as a north-star event yet', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: history.weak(concept) }, system));
    const done = expectValue(await handlerOn().handle({ learnerRef: learner, evidence: history.qualifying(concept) }, system));

    expect(done.transitions).toHaveLength(1);
    expect(await transitions(learner)).toMatchObject([{ from_state: 'weak', to_state: 'strong', is_regression: false, verified_at: null, rule_set_id: '00000000-0000-4000-8000-0000000000d2' }]);
    const links = (await database.pool.query(`SELECT role, count(*)::int AS n FROM learning.mastery_transition_evidence GROUP BY role`)).rows;
    expect(links).toEqual([{ role: 'qualifying', n: 8 }]);
    expect(await northStar(learner)).toBe(0);
  });

  it('refuses to verify it inside the gap, whatever the answers: forty-eight hours is measured from the response, not from the delivery', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    // the qualification is on day 2; ten hours later, a new sitting, new items, both right
    const soon = expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 10) }, system));
    expect(soon.verified).toEqual([]);
    expect(await northStar(learner)).toBe(0);
    expect((await transitions(learner))[0]!.verified_at).toBeNull();
  });

  it('refuses to verify it in the same sitting, however long after: the sitting is the rule set\'s, so a long one is possible and is still the same one', async () => {
    const taxonomy = randomUUID();
    const publish = new PublishMasteryRuleSetHandler({ ruleSets, clock: clockAt(at(0)), identifiers: { next: () => randomUUID() }, audit: new PostgresAuditRecorder(database.pool) as never });
    expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: thresholdsWith({ session: { idleGapMinutes: 60 * 24 * 30 } }) }, { principal: { kind: 'human', id: randomUUID(), roleContext: ['admin'] }, correlationId: 'c', stepUpSatisfied: true }));
    const learner = randomUUID();
    const concept = randomUUID();
    const inTaxonomy = (list: MasteryEvidence[]) => list.map((e) => ({ ...e, taxonomyVersionId: taxonomy }));
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: inTaxonomy([...history.weak(concept), ...history.qualifying(concept)]) }, system));
    // fifty-odd hours after the qualification, new items, both right: past the gap, but in the sitting the qualifying responses were in
    const same = expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: inTaxonomy(history.later(concept, 2, 2 * 24 + 52)) }, system));
    expect(same.verified).toEqual([]);
    expect(await count('SELECT count(*)::int AS n FROM learning.study_session WHERE learner_ref = $1', [learner])).toBe(1);
    expect(await northStar(learner)).toBe(0);
  });

  it('verifies it when the gap, a different sitting and different items all hold, and then it is one north-star event', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    const done = expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system));
    expect(done.verified).toHaveLength(1);

    const [row] = await transitions(learner);
    expect(row).toMatchObject({ from_state: 'weak', to_state: 'strong', is_regression: false });
    expect(row.verified_at.toISOString()).toBe(at(0, (2 * 24 + 60) * 60 + 5));
    const links = (await database.pool.query(`SELECT role, count(*)::int AS n FROM learning.mastery_transition_evidence GROUP BY role ORDER BY role`)).rows;
    expect(links).toEqual([{ role: 'qualifying', n: 8 }, { role: 'verifying', n: 2 }]);
    expect(await northStar(learner)).toBe(1);
  });

  it('verifies it once: the same verifying responses delivered again change nothing', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    const verifying = history.later(concept, 2, 2 * 24 + 60);
    expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: verifying }, system));
    const again = expectValue(await handlerOn(database.pool, at(31)).handle({ learnerRef: learner, evidence: verifying }, system));
    expect(again).toMatchObject({ recorded: 0, transitions: [], verified: [] });
    expect(await northStar(learner)).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_transition WHERE learner_ref = $1', [learner])).toBe(1);
  });
});

describe('a transition is pinned to the rules that decided it', () => {
  it('verifies a pending qualification under the thresholds it was pinned to, even after a looser rule set is published', async () => {
    const taxonomy = randomUUID();
    const admin = { principal: { kind: 'human' as const, id: randomUUID(), roleContext: ['admin'] }, correlationId: 'c', stepUpSatisfied: true };
    const publish = new PublishMasteryRuleSetHandler({ ruleSets, clock: clockAt(at(0)), identifiers: { next: () => randomUUID() }, audit: new PostgresAuditRecorder(database.pool) as never });
    const strict = expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: thresholdsWith({ verification: { minGapHours: 48 } }) }, admin));
    const learner = randomUUID();
    const concept = randomUUID();
    const inTaxonomy = (list: MasteryEvidence[]) => list.map((e) => ({ ...e, taxonomyVersionId: taxonomy }));
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: inTaxonomy([...history.weak(concept), ...history.qualifying(concept)]) }, system));
    expect((await transitions(learner))[0]!.rule_set_id).toBe(strict.ruleSetId);

    // an hour of gap is now all that is asked of a new qualification; this one was decided under forty-eight
    expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: thresholdsWith({ verification: { minGapHours: 1 } }) }, admin));
    expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: inTaxonomy(history.later(concept, 2, 2 * 24 + 10)) }, system));
    expect(await northStar(learner)).toBe(0);
    expectValue(await handlerOn(database.pool, at(31)).handle({ learnerRef: learner, evidence: inTaxonomy(history.later(concept, 2, 2 * 24 + 70, randomUUID())).map((e, i) => ({ ...e, slotRef: `late${i}` })) }, system));
    expect(await northStar(learner)).toBe(1);
    // the transition still names the rule set it was decided under
    expect((await transitions(learner))[0]!.rule_set_id).toBe(strict.ruleSetId);
  });
});

describe('a regression is recorded, and the gain it reverses is not touched', () => {
  it('appends a transition out of strong and leaves the verified gain exactly as it was', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system));
    const [gain] = await transitions(learner);

    const wrong = Array.from({ length: 4 }, (_, i) => evidence({ attempt: randomUUID(), slot: `x${i}`, concept, outcome: 'incorrect', occurredAt: at(0, (2 * 24 + 70) * 60 + i * 5) }));
    const fell = expectValue(await handlerOn(database.pool, at(31)).handle({ learnerRef: learner, evidence: wrong }, system));
    expect(fell.transitions.map((t) => [t.from, t.isRegression])).toEqual([['strong', true]]);

    const all = await transitions(learner);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(gain);
    expect(all[1]).toMatchObject({ from_state: 'strong', is_regression: true, verified_at: null });
    expect(await northStar(learner)).toBe(1);
  });
});

describe('a delivery\'s transitions commit with its evidence or not at all', () => {
  it('writes no evidence, no state and no transition when the transition write fails', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const refusing = new Proxy(database.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect();
            const original = client.query;
            const release = client.release.bind(client);
            client.query = ((text: unknown, ...rest: unknown[]) =>
              typeof text === 'string' && /INSERT INTO learning\.mastery_transition\b/u.test(text)
                ? Promise.reject(new Error('injected: the transition write is refused'))
                : (original as (...a: unknown[]) => unknown).call(client, text, ...rest)) as never;
            client.release = ((...args: unknown[]) => {
              client.query = original;
              return (release as (...a: unknown[]) => void)(...args);
            }) as never;
            return client;
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Pool;
    const run = [...history.weak(concept), ...history.qualifying(concept)];
    expect(expectError(await handlerOn(refusing).handle({ learnerRef: learner, evidence: run }, system)).code).toBe('LEDGER_UNAVAILABLE');
    for (const table of ['mastery_evidence', 'study_session', 'concept_state', 'mastery_transition']) {
      expect(await count(`SELECT count(*)::int AS n FROM learning.${table}`), table).toBe(0);
    }
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: run }, system));
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_transition WHERE learner_ref = $1', [learner])).toBe(1);
  });

  it('aborts with the cause, not as an unavailable ledger, when the rule set a promotion was pinned to can no longer be found', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    const lost = new RecordMasteryEvidenceHandler({
      ledger: new PostgresLearningLedger(database.pool),
      ruleSets: { currentFor: (t: string) => ruleSets.currentFor(t), byId: async () => ({ ok: false, error: { kind: 'NotFound', code: 'NO_RULE_SET', message: 'gone' } }) } as never,
      clock: clockAt(at(30)),
      identifiers: { next: () => randomUUID() },
    });
    expect(expectError(await lost.handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system)).code).toBe('NO_RULE_SET');
    expect(await count('SELECT count(*)::int AS n FROM learning.mastery_evidence WHERE learner_ref = $1', [learner])).toBe(12);
  });
});

describe('transitions are history, at the database', () => {
  async function verifiedGain() {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await handlerOn().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    expectValue(await handlerOn(database.pool, at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system));
    return learner;
  }

  it('refuses to delete a transition, to edit one, to verify one again, and to move a link', async () => {
    const learner = await verifiedGain();
    for (const statement of [
      `DELETE FROM learning.mastery_transition WHERE learner_ref = '${learner}'`,
      `UPDATE learning.mastery_transition SET to_state = 'developing' WHERE learner_ref = '${learner}'`,
      `UPDATE learning.mastery_transition SET verified_at = verified_at + interval '1 hour' WHERE learner_ref = '${learner}'`,
      `UPDATE learning.mastery_transition SET verified_at = NULL WHERE learner_ref = '${learner}'`,
    ]) {
      await expect(database.pool.query(statement), statement).rejects.toThrow(/learning_mastery_transition_is_history/u);
    }
    await expect(database.pool.query(`DELETE FROM learning.mastery_transition_evidence`)).rejects.toThrow(/learning_mastery_transition_is_history/u);
    await expect(database.pool.query(`UPDATE learning.mastery_transition_evidence SET role = 'qualifying'`)).rejects.toThrow(/learning_mastery_transition_is_history/u);
  });

  it('refuses a verified regression, a promotion into anything but strong, a regression out of anything but strong, and a no-op change', async () => {
    const insert = (from: string, to: string, regression: boolean, verified: string | null) =>
      database.pool.query(
        `INSERT INTO learning.mastery_transition (transition_id, learner_ref, taxonomy_version_id, concept_identity_id, from_state, to_state, occurred_at, verified_at, is_regression, rule_set_id, rule_set_hash, recorded_at)
         VALUES ($1, $1, $1, $1, $2, $3, $5, $4, $6, '00000000-0000-4000-8000-0000000000d2', repeat('a', 64), now())`,
        [randomUUID(), from, to, verified, at(1), regression],
      );
    await expect(insert('strong', 'developing', true, at(2))).rejects.toThrow(/regression_is_never_verified/u);
    await expect(insert('weak', 'developing', false, null)).rejects.toThrow(/promotion_enters_strong/u);
    await expect(insert('developing', 'weak', true, null)).rejects.toThrow(/regression_leaves_strong/u);
    await expect(insert('weak', 'weak', false, null)).rejects.toThrow(/changes_state/u);
    await expect(insert('weak', 'strong', false, at(0))).rejects.toThrow(/verified_after_it_happened/u);
  });
});
