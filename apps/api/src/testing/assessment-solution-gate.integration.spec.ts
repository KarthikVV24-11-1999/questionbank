import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAttempt, submitAttempt, type Attempt } from '../contexts/assessment/domain/attempt.js';
import { acceptResponseEvent, type ResponseEventDraft } from '../contexts/assessment/domain/response-event.js';
import { PostgresAttemptRepository } from '../contexts/assessment/infrastructure/attempt.repository.js';
import { PostgresResponseLog } from '../contexts/assessment/infrastructure/response-log.repository.js';
import { PostgresSolutionReleases } from '../contexts/assessment/infrastructure/solution-release.repository.js';
import { GetSlotSolutionHandler } from '../contexts/assessment/application/handlers/slot-solution-handler.js';
import { StubSolutions } from './assessment-fakes.js';
import { TAG, anAttempt, id, slots } from './assessment-fixtures.js';
import { storeActiveForm } from './assessment-store.js';
import { connectTestDatabase, type TestDatabase } from './database.js';
import { expectValue } from './expect-result.js';

/**
 * The effort gate over stored facts (FRS 277, M7-36). The rule is the `assessment.solution_release` view, and these tests put events into the real log and ask
 * the real view — per slot, for a practice run that releases as it goes and for a mock that waits for submission.
 *
 * **The check can fail.** The same scenario is run against three planted gates, each wrong in the way the rule exists to prevent, and each is shown to give a different
 * answer from the real one: a gate per attempt, a gate that counts a visit as effort, and a gate that ignores the delivery the attempt pinned.
 */
let database: TestDatabase;
let log: PostgresResponseLog;
let attempts: PostgresAttemptRepository;
let releases: PostgresSolutionReleases;

const MOCK = id(TAG.attempt);
const PRACTICE = id(TAG.attempt, 2);
const slot = (n: number): string => id(TAG.slot, n);
const AT = '2026-10-21T09:05:00.000Z';

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  log = new PostgresResponseLog(database.pool);
  attempts = new PostgresAttemptRepository(database.pool);
  releases = new PostgresSolutionReleases(database.pool);
});

afterAll(async () => {
  await clean();
  await database.revertMigrations();
  await database.close();
});

async function clean(): Promise<void> {
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form_session, assessment.form CASCADE');
}

beforeEach(async () => {
  await clean();
  await storeActiveForm(database.pool);
});

async function live(attempt: Attempt): Promise<Attempt> {
  expectValue(await attempts.create(attempt));
  const started = expectValue(startAttempt(attempt, '2026-10-21T09:00:00.000Z'));
  expectValue(await attempts.save(started, 'created'));
  return started;
}

let sequence = 0;
async function record(attempt: Attempt, slotNumber: number, kind: ResponseEventDraft['kind']): Promise<void> {
  sequence += 1;
  const draft: ResponseEventDraft = {
    eventId: id(TAG.event, sequence + (attempt.attemptId === PRACTICE ? 500 : 0)),
    attemptId: attempt.attemptId,
    slotId: slot(slotNumber),
    sequence,
    kind,
    ...(kind === 'select' || kind === 'change' ? { answer: 'B' } : {}),
    clientMonotonicMs: 1000 * sequence,
    deviceRef: 'phone-1',
  };
  expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft, AT))));
}

async function submit(attempt: Attempt): Promise<Attempt> {
  const submitted = expectValue(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));
  expectValue(await attempts.save(submitted, 'in_progress'));
  return submitted;
}

type Gate = (attemptId: string, slotId: string) => Promise<boolean>;

const realGate: Gate = async (attemptId, slotId) => expectValue(await releases.releasedSlot(attemptId, slotId)) !== undefined;

/** Planted: effort anywhere in the attempt releases every slot of it — the bug the gate exists to prevent. */
const perAttemptGate: Gate = async (attemptId) =>
  (await database.pool.query(`SELECT 1 FROM assessment.response_event WHERE attempt_id = $1 AND kind IN ('select', 'change', 'skip')`, [attemptId])).rowCount! > 0;

/** Planted: a visit is scrolling past, and this gate calls it effort. */
const visitCountsGate: Gate = async (attemptId, slotId) =>
  (await database.pool.query(`SELECT 1 FROM assessment.response_event WHERE attempt_id = $1 AND slot_id = $2 AND kind IN ('select', 'change', 'skip', 'visit')`, [attemptId, slotId])).rowCount! > 0;

/** Planted: effort is enough whatever the attempt pinned, so a mock releases before it is submitted. */
const ignoresDeliveryGate: Gate = async (attemptId, slotId) =>
  (await database.pool.query(`SELECT 1 FROM assessment.response_event WHERE attempt_id = $1 AND slot_id = $2 AND kind IN ('select', 'change', 'skip')`, [attemptId, slotId])).rowCount! > 0;

/** Plays one scenario on a practice run and on a mock and reports what the gate said at each step. */
async function observe(gate: Gate): Promise<Record<string, boolean[]>> {
  const practice = await live(anAttempt({ attemptId: PRACTICE, mode: 'practice', formId: null, sessionRef: null, shiftId: null, windowClosesAt: null, durationMs: null, slots: slots(4), deliveryPolicy: { feedbackMode: 'immediate', pausable: true } }));
  const mock = await live(anAttempt({ attemptId: MOCK, slots: slots(4) }));
  const asked = async (attempt: Attempt, n: number): Promise<boolean[]> => Promise.all([1, 2, 3, 4].slice(0, n).map((s) => gate(attempt.attemptId, slot(s))));

  const seen: Record<string, boolean[]> = {};
  seen['practice, nothing yet'] = await asked(practice, 4);
  await record(practice, 1, 'visit');
  seen['practice, slot 1 only visited'] = await asked(practice, 4);
  await record(practice, 1, 'select');
  seen['practice, slot 1 answered'] = await asked(practice, 4);
  await record(practice, 2, 'skip');
  seen['practice, slot 2 skipped'] = await asked(practice, 4);
  await record(practice, 1, 'clear');
  seen['practice, slot 1 answered then cleared'] = await asked(practice, 4);

  await record(mock, 1, 'select');
  await record(mock, 2, 'skip');
  await record(mock, 3, 'visit');
  seen['mock, answered and skipped, not yet submitted'] = await asked(mock, 4);
  const submitted = await submit(mock);
  seen['mock, after submission'] = await asked(mock, 4);
  await record(submitted, 4, 'select');
  seen['mock, a late answer on slot 4'] = await asked(mock, 4);
  return seen;
}

const EXPECTED: Record<string, boolean[]> = {
  'practice, nothing yet': [false, false, false, false],
  'practice, slot 1 only visited': [false, false, false, false],
  'practice, slot 1 answered': [true, false, false, false],
  'practice, slot 2 skipped': [true, true, false, false],
  'practice, slot 1 answered then cleared': [true, true, false, false],
  'mock, answered and skipped, not yet submitted': [false, false, false, false],
  'mock, after submission': [true, true, false, false],
  'mock, a late answer on slot 4': [true, true, false, true],
};

describe('the effort gate reads stored facts, per slot', () => {
  it('releases a practice slot as it is attempted or skipped and a mock slot once submitted, and never a slot without effort', async () => {
    expect(await observe(realGate)).toEqual(EXPECTED);
  });

  it('is not vacuous: each planted gate gives a different answer from the real one, and the scenario names where', async () => {
    for (const [name, planted] of [['per attempt', perAttemptGate], ['visit as effort', visitCountsGate], ['ignores the delivery', ignoresDeliveryGate]] as const) {
      await clean();
      await storeActiveForm(database.pool);
      sequence = 0;
      const seen = await observe(planted);
      const differing = Object.keys(EXPECTED).filter((step) => JSON.stringify(seen[step]) !== JSON.stringify(EXPECTED[step]));
      expect(differing.length, name).toBeGreaterThan(0);
    }
  });

  it('carries the version the slot pinned, and releases nothing for a slot the attempt does not have', async () => {
    const practice = await live(anAttempt({ attemptId: PRACTICE, mode: 'practice', formId: null, sessionRef: null, shiftId: null, windowClosesAt: null, durationMs: null, slots: slots(2), deliveryPolicy: { feedbackMode: 'immediate', pausable: true } }));
    await record(practice, 2, 'skip');
    const released = expectValue(await releases.releasedSlot(PRACTICE, slot(2)));
    expect(released).toMatchObject({ attemptId: PRACTICE, slotId: slot(2), itemVersionId: id(TAG.itemVersion, 2) });
    expect(expectValue(await releases.releasedSlot(PRACTICE, slot(5)))).toBeUndefined();
  });

  it('is a view, so nothing writes the answer to it', async () => {
    const { rows } = await database.pool.query(`SELECT relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'assessment' AND c.relname = 'solution_release'`);
    expect(rows).toEqual([{ relkind: 'v' }]);
  });

  it('is what the handler asks: a skipped slot is served and its sibling is refused, with the source asked once', async () => {
    const practice = await live(anAttempt({ attemptId: PRACTICE, mode: 'practice', formId: null, sessionRef: null, shiftId: null, windowClosesAt: null, durationMs: null, slots: slots(2), deliveryPolicy: { feedbackMode: 'immediate', pausable: true } }));
    await record(practice, 1, 'skip');
    const solutions = new StubSolutions();
    const handler = new GetSlotSolutionHandler({ attempts, releases, solutions });
    const learner = { principal: { kind: 'human' as const, id: practice.studentId, roleContext: ['learner'] }, correlationId: 'c' };

    const served = expectValue(await handler.handle({ attemptId: PRACTICE, slotId: slot(1), depth: 'basic' }, learner));
    expect(served.sections.map((section) => section.kind)).toEqual(['method']);
    const refused = await handler.handle({ attemptId: PRACTICE, slotId: slot(2), depth: 'basic' }, learner);
    expect(refused).toMatchObject({ ok: false, error: { code: 'SOLUTION_NOT_RELEASED' } });
    expect(solutions.asked).toEqual([{ itemVersionId: id(TAG.itemVersion, 1), depth: 'basic' }]);
  });
});
