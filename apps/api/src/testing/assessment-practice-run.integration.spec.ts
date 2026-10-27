import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../platform/config/config.js';
import { CreatePracticeAttemptHandler, GrowPracticeAttemptHandler } from '../contexts/assessment/application/handlers/practice-handlers.js';
import { GetAttemptHandler, IngestResponseEventsHandler, StartAttemptHandler, SubmitAttemptHandler } from '../contexts/assessment/application/handlers/attempt-handlers.js';
import type { AssemblyCandidate } from '../contexts/assessment/domain/assembly.js';
import { PostgresAttemptRepository } from '../contexts/assessment/infrastructure/attempt.repository.js';
import { PostgresExposureLedger } from '../contexts/assessment/infrastructure/exposure-ledger.repository.js';
import { PostgresResponseLog } from '../contexts/assessment/infrastructure/response-log.repository.js';
import type { ApplicationContext } from '../contexts/assessment/application/ports.js';
import { StubCorpus, StubPins } from './assessment-fakes.js';
import { TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';
import { expectValue } from './expect-result.js';

/**
 * A practice run end to end against the real store (M7-27, M7-29, M7-30): created, grown, put down for two months and picked up, submitted — with the
 * exposure ledger and the outbox checked at each step. The handlers are the real ones; only the catalogue and the profile pins are supplied.
 */
let database: TestDatabase;
const LEARNER: ApplicationContext = { principal: { kind: 'human', id: id(TAG.student, 1), roleContext: ['learner'] }, correlationId: 'corr' };
const cand = (n: number): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null,
});

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await clean();
  await database.revertMigrations();
  await database.close();
});
async function clean(): Promise<void> {
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form_session, assessment.form CASCADE');
}
beforeEach(clean);

function deps(now: string, candidates: AssemblyCandidate[]) {
  let n = 0;
  return {
    attempts: new PostgresAttemptRepository(database.pool),
    responses: new PostgresResponseLog(database.pool),
    corpus: new StubCorpus({ candidates, exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }),
    practicePins: new StubPins(),
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    clock: { now: () => new Date(now) },
    identifiers: { next: () => id(0xd0, (n += 1) + Math.floor(Math.random() * 1_000_000)) },
    audit: { record: async () => undefined },
  } as never;
}

describe('a practice run against the real store', () => {
  it('is created with its exposure, grown with more, and each delivery is counted once', async () => {
    const candidates = [1, 2, 3, 4, 5].map(cand);
    const d = deps('2026-10-27T09:00:00.000Z', candidates);
    const created = expectValue(await new CreatePracticeAttemptHandler(d).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 2, idempotencyKey: 'k' }, LEARNER));
    const ledger = new PostgresExposureLedger(database.pool);
    const rows = async () => (await database.pool.query('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry WHERE attempt_id = $1', [created.attempt.attemptId])).rows[0].n as number;
    expect(await rows()).toBe(2);
    expectValue(await new GrowPracticeAttemptHandler(d).handle({ attemptId: created.attempt.attemptId, count: 2 }, LEARNER));
    expect(await rows()).toBe(4);
    const counts = expectValue(await ledger.countsByItemVersion(candidates.map((c) => c.itemVersionId)));
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(4);
    // a replay of the same key writes nothing more
    const again = expectValue(await new CreatePracticeAttemptHandler(d).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 2, idempotencyKey: 'k' }, LEARNER));
    expect(again.replayed).toBe(true);
    expect(await rows()).toBe(4);
  });

  it('is put down for two months and picked up, takes a response, and is submitted — with no deadline, no window, and no event for scoring', async () => {
    const candidates = [1, 2, 3].map(cand);
    const start = deps('2026-10-27T09:00:00.000Z', candidates);
    const created = expectValue(await new CreatePracticeAttemptHandler(start).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 3, idempotencyKey: 'k' }, LEARNER));
    const attemptId = created.attempt.attemptId;
    expectValue(await new StartAttemptHandler(start).handle({ attemptId }, LEARNER));
    const slotId = (await database.pool.query('SELECT slot_id FROM assessment.attempt_slot WHERE attempt_id = $1 ORDER BY ordinal LIMIT 1', [attemptId])).rows[0].slot_id as string;

    const later = deps('2026-12-27T09:00:00.000Z', candidates);
    const view = expectValue(await new GetAttemptHandler(later).handle({ attemptId }, LEARNER));
    expect([view.state, view.deadline, view.windowClosesAt]).toEqual(['in_progress', null, null]);
    const report = expectValue(await new IngestResponseEventsHandler(later).handle({ attemptId, events: [{ eventId: id(TAG.event, 1), attemptId, slotId, sequence: 1, kind: 'select', answer: 'A', clientMonotonicMs: 10, deviceRef: 'd' }] }, LEARNER));
    expect(report.results[0]!.outcome).toBe('accepted');
    const repo = new PostgresAttemptRepository(database.pool);
    expect(expectValue(await repo.findExpired('2099-01-01T00:00:00.000Z', 10))).toEqual([]);
    expect(expectValue(await repo.findAbandonable('2099-01-01T00:00:00.000Z', 10))).toEqual([]);

    const outboxBefore = (await database.pool.query('SELECT count(*)::int AS n FROM platform.outbox_message')).rows[0].n as number;
    const submitted = expectValue(await new SubmitAttemptHandler(later).handle({ attemptId, reason: 'manual', idempotencyKey: 's' }, LEARNER));
    expect(submitted.state).toBe('submitted');
    expect((await database.pool.query('SELECT count(*)::int AS n FROM platform.outbox_message')).rows[0].n).toBe(outboxBefore);
  });
});
