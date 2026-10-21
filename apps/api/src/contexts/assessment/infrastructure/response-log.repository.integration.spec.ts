import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { storeActiveForm } from '../../../testing/assessment-store.js';
import { startAttempt, submitAttempt, type Attempt } from '../domain/attempt.js';
import { acceptResponseEvent, scoredEvents, type ResponseEventDraft } from '../domain/response-event.js';
import { PostgresAttemptRepository } from './attempt.repository.js';
import { PostgresFormRepository } from './form.repository.js';
import { PostgresResponseLog } from './response-log.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let log: PostgresResponseLog;
let attempts: PostgresAttemptRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  log = new PostgresResponseLog(database.pool);
  attempts = new PostgresAttemptRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
  await storeActiveForm(database.pool);
});

async function liveAttempt(): Promise<Attempt> {
  const created = anAttempt();
  expectValue(await attempts.create(created));
  const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
  expectValue(await attempts.save(started, 'created'));
  return started;
}

function draft(n: number, overrides: Partial<ResponseEventDraft> = {}): ResponseEventDraft {
  return {
    eventId: id(TAG.event, n),
    attemptId: id(TAG.attempt),
    slotId: id(TAG.slot, 1),
    sequence: n,
    kind: 'select',
    answer: 'B',
    clientMonotonicMs: 1000 * n,
    deviceRef: 'phone-1',
    ...overrides,
  };
}

const RECEIVED = '2026-10-21T09:05:00.000Z';

describe('appending and reading events', () => {
  // Field by field against literals, never `toEqual(saved)` (ADR-0017).
  it('reads back every field of an event, with the item version the slot pinned', async () => {
    const attempt = await liveAttempt();
    const event = expectValue(acceptResponseEvent(attempt, draft(1, { slotId: id(TAG.slot, 2), answer: ['A', 'C'], kind: 'change' }), RECEIVED));
    const appended = expectValue(await log.append(event));
    expect(appended.afterSubmission).toBe(false);

    const [found] = expectValue(await log.findByAttempt(id(TAG.attempt)));
    expect(found!.eventId).toBe('000000c1-0000-4000-8000-000000000001');
    expect(found!.attemptId).toBe('000000a1-0000-4000-8000-000000000001');
    expect(found!.slotId).toBe('000000b1-0000-4000-8000-000000000002');
    expect(found!.itemVersionId).toBe('000000b3-0000-4000-8000-000000000002');
    expect(found!.sequence).toBe(1);
    expect(found!.kind).toBe('change');
    expect(found!.answer).toEqual(['A', 'C']);
    expect(found!.clientMonotonicMs).toBe(1000);
    expect(found!.serverReceivedAt).toBe(RECEIVED);
    expect(found!.deviceRef).toBe('phone-1');
    expect(found!.afterSubmission).toBe(false);
    expect(Object.keys(found!).sort()).toEqual([
      'afterSubmission', 'answer', 'attemptId', 'clientMonotonicMs', 'deviceRef', 'eventId', 'itemVersionId', 'kind', 'sequence', 'serverReceivedAt', 'slotId',
    ]);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('stores an answer-free event with a SQL null and every kind it can be', async () => {
    const attempt = await liveAttempt();
    for (const [i, kind] of (['visit', 'leave', 'flag', 'unflag', 'clear'] as const).entries()) {
      expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(i + 1, { kind, answer: null }), RECEIVED))));
    }
    const events = expectValue(await log.findByAttempt(id(TAG.attempt)));
    expect(events.map((e) => [e.kind, e.answer])).toEqual([['visit', null], ['leave', null], ['flag', null], ['unflag', null], ['clear', null]]);
    const { rows } = await database.pool.query(`SELECT count(*)::int AS n FROM assessment.response_event WHERE answer IS NULL`);
    expect(rows[0]).toEqual({ n: 5 });
  });

  it('reads events in client sequence then id, however they arrived', async () => {
    const attempt = await liveAttempt();
    for (const n of [3, 1, 2]) {
      expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(n), RECEIVED))));
    }
    expect(expectValue(await log.findByAttempt(id(TAG.attempt))).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('keeps every change of an answer as a row of its own', async () => {
    const attempt = await liveAttempt();
    const kinds = ['select', 'change', 'change', 'change'] as const;
    for (const [i, kind] of kinds.entries()) {
      expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(i + 1, { kind, answer: `opt${i}` }), RECEIVED))));
    }
    const events = expectValue(await log.findByAttempt(id(TAG.attempt)));
    expect(events.filter((e) => e.kind === 'change')).toHaveLength(3);
    expect(events.map((e) => e.answer)).toEqual(['opt0', 'opt1', 'opt2', 'opt3']);
  });

  it('is empty for an attempt with no events', async () => {
    expect(expectValue(await log.findByAttempt(id(TAG.attempt)))).toEqual([]);
  });
});

describe('append is idempotent on the event id', () => {
  it('writes nothing the second time and returns what is stored, even with a later receipt time', async () => {
    const attempt = await liveAttempt();
    const first = expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED))));
    const replay = expectValue(acceptResponseEvent(attempt, draft(1), '2026-10-21T09:07:00.000Z'));
    const second = expectValue(await log.append(replay));
    expect(second.serverReceivedAt).toBe(first.serverReceivedAt);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.response_event')).rows[0]).toEqual({ n: 1 });
  });

  it('refuses a different event under a used id, and leaves the stored one alone', async () => {
    const attempt = await liveAttempt();
    expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(1, { answer: 'B' }), RECEIVED))));
    const failure = expectError(await log.append(expectValue(acceptResponseEvent(attempt, draft(1, { answer: 'C' }), RECEIVED))));
    expect(failure.code).toBe('CONFLICT');
    expect(expectValue(await log.findByAttempt(id(TAG.attempt)))[0]?.answer).toBe('B');
  });

  it('notices a difference in any compared field', async () => {
    const attempt = await liveAttempt();
    expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED))));
    const variants: Partial<ResponseEventDraft>[] = [
      { slotId: id(TAG.slot, 2) },
      { sequence: 9 },
      { kind: 'change' },
      { clientMonotonicMs: 5 },
      { deviceRef: 'laptop' },
    ];
    for (const variant of variants) {
      expect(expectError(await log.append(expectValue(acceptResponseEvent(attempt, draft(1, variant), RECEIVED)))).code, JSON.stringify(variant)).toBe('CONFLICT');
    }
  });
});

describe('events arriving after submission', () => {
  it('are recorded, flagged, and left out of what scoring sees', async () => {
    const attempt = await liveAttempt();
    expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED))));
    const submitted = expectValue(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));
    expectValue(await attempts.save(submitted, 'in_progress'));

    const late = expectValue(acceptResponseEvent(submitted, draft(2, { kind: 'change', answer: 'Z' }), '2026-10-21T10:05:00.000Z'));
    expect(late.afterSubmission).toBe(true);
    expect(expectValue(await log.append(late)).afterSubmission).toBe(true);

    const events = expectValue(await log.findByAttempt(id(TAG.attempt)));
    expect(events.map((e) => [e.sequence, e.afterSubmission])).toEqual([[1, false], [2, true]]);
    expect(scoredEvents(events).map((e) => e.sequence)).toEqual([1]);
  });

  it('takes the database\'s word for it: an event the domain thought in time, arriving after a racing submission, is stored late', async () => {
    const attempt = await liveAttempt();
    const inTime = expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED));
    expect(inTime.afterSubmission).toBe(false);
    expectValue(await attempts.save(expectValue(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z')), 'in_progress'));
    expect(expectValue(await log.append(inTime)).afterSubmission).toBe(true);
  });

  it('are refused outright for an attempt that never started', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    const event = expectValue(acceptResponseEvent(started, draft(1), RECEIVED));
    const failure = expectError(await log.append(event));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('assessment_attempt_not_accepting_responses');
  });
});

describe('the item version is pinned, and the database holds the pin', () => {
  it('refuses an event whose version is not the slot\'s, whatever the domain made', async () => {
    const attempt = await liveAttempt();
    const event = expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED));
    const failure = expectError(await log.append({ ...event, itemVersionId: id(TAG.itemVersion, 99) }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('response_event_pin_matches_slot');
  });
});

describe('how many slots have been answered', () => {
  it('counts distinct slots with a select or change that counts, and nothing else', async () => {
    const attempt = await liveAttempt();
    expect(expectValue(await log.answeredSlotCount(id(TAG.attempt)))).toBe(0);
    const send = async (n: number, overrides: Partial<ResponseEventDraft>) =>
      expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft(n, overrides), RECEIVED))));
    await send(1, { kind: 'visit', answer: null });
    await send(2, { kind: 'flag', answer: null });
    expect(expectValue(await log.answeredSlotCount(id(TAG.attempt)))).toBe(0);
    await send(3, { slotId: id(TAG.slot, 1) });
    await send(4, { slotId: id(TAG.slot, 1), kind: 'change', answer: 'C' });
    await send(5, { slotId: id(TAG.slot, 2) });
    expect(expectValue(await log.answeredSlotCount(id(TAG.attempt)))).toBe(2);
  });

  it('leaves out an answer that arrived after submission', async () => {
    const attempt = await liveAttempt();
    const submitted = expectValue(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));
    expectValue(await attempts.save(submitted, 'in_progress'));
    expectValue(await log.append(expectValue(acceptResponseEvent(submitted, draft(1), RECEIVED))));
    expect(expectValue(await log.answeredSlotCount(id(TAG.attempt)))).toBe(0);
  });
});

describe('what the store refuses', () => {
  it('reports a connection failure as a value', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    pool.on('error', () => undefined);
    const broken = new PostgresResponseLog(pool);
    const attempt = await liveAttempt();
    const event = expectValue(acceptResponseEvent(attempt, draft(1), RECEIVED));
    expect(expectError(await broken.append(event)).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await broken.findByAttempt(id(TAG.attempt))).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await broken.answeredSlotCount(id(TAG.attempt))).code).toBe('PERSISTENCE_REJECTED');
    await pool.end().catch(() => undefined);
  });
});
