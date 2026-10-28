import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { describe, expect, it } from 'vitest';
import { conflictError } from '../domain/assessment-error.js';
import type { Attempt } from '../domain/attempt.js';
import { err, ok } from '../domain/result.js';
import { InMemoryAttempts, InMemoryForms, InMemoryResponses, StubPins, StubScoreRecords } from '../../../testing/assessment-fakes.js';
import { SESSION_REF, TAG, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  CreateAttemptHandler,
  GetAttemptHandler,
  GetAttemptResultHandler,
  IngestResponseEventsHandler,
  MAX_EVENTS_PER_BATCH,
  StartAttemptHandler,
  SubmitAttemptHandler,
} from './handlers/attempt-handlers.js';
import type { ApplicationContext, AuditRecord } from './ports.js';

/**
 * The attempt handlers against doubles: what each decides, in the paths a real database would have to be coaxed into.
 * The routes through real Postgres, and the outage and device-switch scenarios, are in
 * `assessment-attempts.integration.spec.ts`; this is the branch-by-branch account.
 */
const STUDENT = id(TAG.student, 1);
const ctx = (role = 'learner', sub = STUDENT): ApplicationContext => ({ principal: { kind: 'human', id: sub, roleContext: [role] }, correlationId: 'c' });
const FORM = anActiveForm();

function rig() {
  const forms = new InMemoryForms();
  forms.stored.set(FORM.formId, FORM);
  const attempts = new InMemoryAttempts();
  const responses = new InMemoryResponses(attempts);
  const pins = new StubPins();
  const clock = { at: '2026-10-21T09:00:00.000Z' };
  let n = 0;
  const recorded: AuditRecord[] = [];
  const deps = {
    forms,
    attempts,
    responses,
    pins,
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    scoreRecord: new StubScoreRecords(),
    clock: { now: () => new Date(clock.at) },
    identifiers: { next: () => id(TAG.attempt, (n += 1)) },
    audit: { record: async (entry: AuditRecord) => void recorded.push(entry) },
  };
  return { deps, forms, attempts, responses, pins, clock, recorded };
}

const create = (r: ReturnType<typeof rig>, key = 'k', context = ctx()) => new CreateAttemptHandler(r.deps).handle({ formId: FORM.formId, sessionRef: SESSION_REF, idempotencyKey: key }, context);

async function started(r: ReturnType<typeof rig>) {
  const created = expectValue(await create(r));
  expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId: created.attempt.attemptId }, ctx()));
  return created.attempt.attemptId;
}

const wire = (attemptId: string, n: number, kind = 'visit') => ({ eventId: id(TAG.event, n), attemptId, slotId: id(TAG.slot, 1), sequence: n, kind: kind as 'visit', clientMonotonicMs: n * 10, deviceRef: 'd' });

describe('who may', () => {
  it('is for a learner and no one else, on every handler', async () => {
    const r = rig();
    const attemptId = 'x';
    const denied = [
      await new CreateAttemptHandler(r.deps).handle({ formId: FORM.formId, sessionRef: SESSION_REF, idempotencyKey: 'k' }, ctx('content_ops')),
      await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx('system')),
      await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx('guest')),
      await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [] }, ctx('author')),
      await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 'k' }, ctx('reviewer')),
    ];
    for (const result of denied as { ok: boolean; error: { kind: string } }[]) expect([result.ok, result.error.kind]).toEqual([false, 'Authorization']);
  });
});

describe('CreateAttempt', () => {
  it('creates, audits once, and answers with the attempt as the student sees it', async () => {
    const r = rig();
    const created = expectValue(await create(r));
    expect(created.replayed).toBe(false);
    expect(created.attempt).toMatchObject({ state: 'created', mode: 'mock', sessionRef: SESSION_REF, shiftId: SESSION_REF, deadline: null, durationMs: 10_800_000 });
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({ action: 'CreateAttempt', targetType: 'attempt', targetId: created.attempt.attemptId });
  });

  it('names a shift when the caller gives one', async () => {
    const r = rig();
    const made = expectValue(await new CreateAttemptHandler(r.deps).handle({ formId: FORM.formId, sessionRef: SESSION_REF, shiftId: 'morning', idempotencyKey: 'k' }, ctx()));
    expect(made.attempt.shiftId).toBe('morning');
  });

  it('passes on a failure reading the form, the pins, the active mock or the store', async () => {
    const r = rig();
    expect(expectError(await new CreateAttemptHandler(r.deps).handle({ formId: id(TAG.form, 77), sessionRef: SESSION_REF, idempotencyKey: 'k' }, ctx())).kind).toBe('NotFound');
    r.pins.failWith = { kind: 'PreconditionFailed', code: 'PROFILE_NOT_SCORABLE', message: 'no' };
    expect(expectError(await create(r, 'k2')).code).toBe('PROFILE_NOT_SCORABLE');
    r.pins.failWith = null;
    r.attempts.findByCreationKey = async () => err(conflictError('CONFLICT', 'down', 'x'));
    expect(expectError(await create(r, 'k3')).code).toBe('CONFLICT');
    const r2 = rig();
    r2.attempts.findActiveMock = async () => err(conflictError('CONFLICT', 'down', 'x'));
    expect(expectError(await create(r2)).code).toBe('CONFLICT');
  });

  it('answers a retry with the attempt the key made, and refuses the key naming something else', async () => {
    const r = rig();
    const first = expectValue(await create(r));
    const again = expectValue(await create(r));
    expect([again.replayed, again.attempt.attemptId]).toEqual([true, first.attempt.attemptId]);
    expect(r.recorded).toHaveLength(1);
    const other = await new CreateAttemptHandler(r.deps).handle({ formId: FORM.formId, sessionRef: 'someone-else', idempotencyKey: 'k' }, ctx());
    expect(expectError(other).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const elsewhere = await new CreateAttemptHandler(r.deps).handle({ formId: id(TAG.form, 2), sessionRef: SESSION_REF, idempotencyKey: 'k' }, ctx());
    expect(expectError(elsewhere).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('names the active mock that is in the way, from the friendly check', async () => {
    const r = rig();
    const first = expectValue(await create(r, 'a'));
    const refused = expectError(await create(r, 'b'));
    expect(refused).toMatchObject({ kind: 'Conflict', code: 'ACTIVE_MOCK_ATTEMPT_EXISTS' });
    expect(refused.message).toContain(first.attempt.attemptId);
  });

  it('treats an active mock that is this very key\'s attempt, found by a racing request, as a replay', async () => {
    const r = rig();
    const first = expectValue(await create(r, 'same'));
    let calls = 0;
    const real = r.attempts.findByCreationKey.bind(r.attempts);
    r.attempts.findByCreationKey = async (student, key) => (calls++ === 0 ? ok(undefined) : real(student, key));
    const racing = expectValue(await create(r, 'same'));
    expect([racing.replayed, racing.attempt.attemptId]).toEqual([true, first.attempt.attemptId]);
  });

  describe('when the store refuses the write', () => {
    it('is a replay when a concurrent create under the same key won', async () => {
      const r = rig();
      const winner = expectValue(await create(r, 'won'));
      r.attempts.blindToActiveMock = true;
      let calls = 0;
      const real = r.attempts.findByCreationKey.bind(r.attempts);
      r.attempts.findByCreationKey = async (student, key) => (calls++ === 0 ? ok(undefined) : real(student, key));
      const raced = expectValue(await create(r, 'won'));
      expect([raced.replayed, raced.attempt.attemptId]).toEqual([true, winner.attempt.attemptId]);
    });

    it('is the active-mock conflict when the index refused it, naming the attempt in the way when it can be found', async () => {
      const r = rig();
      const first = expectValue(await create(r, 'a'));
      let calls = 0;
      const real = r.attempts.findActiveMock.bind(r.attempts);
      r.attempts.findActiveMock = async (student) => (calls++ === 0 ? ok(undefined) : real(student));
      const refused = expectError(await create(r, 'b'));
      expect(refused).toMatchObject({ kind: 'Conflict', code: 'ACTIVE_MOCK_ATTEMPT_EXISTS', detail: { constraint: 'attempt_one_active_mock_per_student' } });
      expect(refused.message).toContain(first.attempt.attemptId);
    });

    it('is the same conflict, without a name, when the attempt in the way cannot be found', async () => {
      const r = rig();
      expectValue(await create(r, 'a'));
      r.attempts.blindToActiveMock = true;
      const refused = expectError(await create(r, 'b'));
      expect(refused.code).toBe('ACTIVE_MOCK_ATTEMPT_EXISTS');
      expect(refused.message).not.toContain('(attempt');
    });

    it('passes on any other refusal as it is', async () => {
      const r = rig();
      r.attempts.create = async () => err({ kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'no', location: 'x' });
      expect(expectError(await create(r)).code).toBe('PERSISTENCE_REJECTED');
      r.attempts.create = async () => err(conflictError('CONFLICT', 'some other index', 'some_other_index'));
      expect(expectError(await create(r, 'k2')).code).toBe('CONFLICT');
    });
  });
});

describe('StartAttempt', () => {
  it('anchors the deadline from the server clock, audits, and is idempotent', async () => {
    const r = rig();
    const created = expectValue(await create(r));
    const attemptId = created.attempt.attemptId;
    const first = expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx()));
    expect([first.state, first.startedAt, first.deadline]).toEqual(['in_progress', '2026-10-21T09:00:00.000Z', '2026-10-21T12:00:00.000Z']);
    r.clock.at = '2026-10-21T10:00:00.000Z';
    const again = expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx()));
    expect(again.deadline).toBe(first.deadline);
    expect(r.recorded.filter((entry) => entry.action === 'StartAttempt')).toHaveLength(1);
  });

  it('refuses another student\'s attempt as NotFound, an attempt that cannot start, and one whose window has closed', async () => {
    const r = rig();
    const attemptId = expectValue(await create(r)).attempt.attemptId;
    expect(expectError(await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx('learner', id(TAG.student, 2)))).kind).toBe('NotFound');
    r.clock.at = '2026-10-21T12:00:00.000Z';
    expect(expectError(await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx())).code).toBe('ATTEMPT_WINDOW_CLOSED');
    const abandoned = rig();
    const id2 = expectValue(await create(abandoned)).attempt.attemptId;
    abandoned.attempts.stored.set(id2, { ...abandoned.attempts.stored.get(id2)!, state: 'abandoned', abandonedAt: '2026-10-21T12:00:00.000Z' } as Attempt);
    expect(expectError(await new StartAttemptHandler(abandoned.deps).handle({ attemptId: id2 }, ctx())).code).toBe('ATTEMPT_TRANSITION_PROHIBITED');
  });

  it('answers with what a racing start made, and otherwise with the refusal', async () => {
    const r = rig();
    const attemptId = expectValue(await create(r)).attempt.attemptId;
    const real = r.attempts.save.bind(r.attempts);
    r.attempts.save = async (attempt, expected) => {
      // another start got in first
      await real({ ...attempt, state: 'in_progress', startedAt: attempt.startedAt, deadline: attempt.deadline } as Attempt, expected);
      return err(conflictError('CONFLICT', 'the attempt moved', 'state'));
    };
    expect(expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId }, ctx())).state).toBe('in_progress');

    const stuck = rig();
    const stuckId = expectValue(await create(stuck)).attempt.attemptId;
    stuck.attempts.stale.add(stuckId);
    expect(expectError(await new StartAttemptHandler(stuck.deps).handle({ attemptId: stuckId }, ctx())).code).toBe('CONFLICT');
  });
});

describe('GetAttempt', () => {
  it('shows the student their attempt with the server\'s reading of the clock, and no one else\'s', async () => {
    const r = rig();
    const attemptId = expectValue(await create(r)).attempt.attemptId;
    expect(expectValue(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx())).serverNow).toBe(r.clock.at);
    expect(expectError(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx('learner', id(TAG.student, 9)))).kind).toBe('NotFound');
    expect(expectError(await new GetAttemptHandler(r.deps).handle({ attemptId: id(TAG.attempt, 999) }, ctx())).kind).toBe('NotFound');
  });

  it('returns the log of what has been done, as the engine shapes an event, in the order the server keeps it (D68)', async () => {
    const r = rig();
    const attemptId = await started(r);
    const answered = { ...wire(attemptId, 2, 'select'), answer: ['a', 'c'] };
    expectValue(await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [answered, wire(attemptId, 1)] }, ctx()));
    const view = expectValue(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx()));
    expect(view.events).toEqual([
      { eventId: id(TAG.event, 1), attemptId, slot: id(TAG.slot, 1), sequence: 1, monotonicMs: 10, kind: 'visit' },
      { eventId: id(TAG.event, 2), attemptId, slot: id(TAG.slot, 1), sequence: 2, monotonicMs: 20, kind: 'select', answer: ['a', 'c'] },
    ]);
  });

  it('leaves out an event that arrived after the submission, and says nothing of what the server added', async () => {
    const r = rig();
    const attemptId = await started(r);
    const ingest = new IngestResponseEventsHandler(r.deps);
    expectValue(await ingest.handle({ attemptId, events: [wire(attemptId, 1)] }, ctx()));
    await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 'k' }, ctx());
    expectValue(await ingest.handle({ attemptId, events: [wire(attemptId, 2)] }, ctx()));
    const view = expectValue(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx()));
    expect(view.events.map((event) => event.eventId)).toEqual([id(TAG.event, 1)]);
    expect(Object.keys(view.events[0]!).sort()).toEqual(['attemptId', 'eventId', 'kind', 'monotonicMs', 'sequence', 'slot']);
  });

  it('is an empty log for an attempt nothing has been done in, and fails, retryably, when the log cannot be read', async () => {
    const r = rig();
    const attemptId = await started(r);
    expect(expectValue(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx())).events).toEqual([]);
    r.responses.findByAttempt = async () => err(conflictError('CONFLICT', 'down', 'x'));
    expect(expectError(await new GetAttemptHandler(r.deps).handle({ attemptId }, ctx())).code).toBe('CONFLICT');
  });
});

describe('GetAttemptResult', () => {
  it('is pending until a score record exists, and the score once it does', async () => {
    const r = rig();
    const attemptId = await started(r);
    await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 'k' }, ctx());
    const handler = new GetAttemptResultHandler(r.deps);
    expect(expectValue(await handler.handle({ attemptId }, ctx()))).toEqual({ attemptId, status: 'pending' });
    (r.deps.scoreRecord as StubScoreRecords).records.set(attemptId, { scoreRecordId: 's', totalRaw: '10' });
    const scored = expectValue(await handler.handle({ attemptId }, ctx()));
    expect(scored).toMatchObject({ attemptId, status: 'scored', score: { totalRaw: '10' } });
    expect((r.deps.scoreRecord as StubScoreRecords).asked).toEqual([{ attemptId, ownerUserId: STUDENT }, { attemptId, ownerUserId: STUDENT }]);
  });

  it('is the student\'s own and only once submitted, and passes on a failure of scoring that is not "not found"', async () => {
    const r = rig();
    const attemptId = await started(r);
    const handler = new GetAttemptResultHandler(r.deps);
    expect(expectError(await handler.handle({ attemptId }, ctx())).code).toBe('ATTEMPT_NOT_SUBMITTED');
    expect(expectError(await handler.handle({ attemptId }, ctx('learner', id(TAG.student, 9)))).kind).toBe('NotFound');
    expect(expectError(await handler.handle({ attemptId }, ctx('content_ops'))).kind).toBe('Authorization');
    await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 'k' }, ctx());
    (r.deps.scoreRecord as StubScoreRecords).failWith = { kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' };
    expect(expectError(await handler.handle({ attemptId }, ctx())).code).toBe('STORE_UNAVAILABLE');
  });
});

describe('IngestResponseEvents', () => {
  it('answers every event, one by one', async () => {
    const r = rig();
    const attemptId = await started(r);
    const report = expectValue(await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [wire(attemptId, 1), wire(attemptId, 2, 'ponder')] }, ctx()));
    expect(report.results.map((result) => result.outcome)).toEqual(['accepted', 'rejected']);
    expect(report.acknowledged).toEqual([id(TAG.event, 1)]);
  });

  it('refuses an empty batch, an over-long one, and an attempt that takes no events', async () => {
    const r = rig();
    const attemptId = await started(r);
    const handler = new IngestResponseEventsHandler(r.deps);
    expect(expectError(await handler.handle({ attemptId, events: [] }, ctx())).code).toBe('EVENT_BATCH_SIZE_INVALID');
    const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => wire(attemptId, i + 1));
    expect(expectError(await handler.handle({ attemptId, events: tooMany }, ctx())).code).toBe('EVENT_BATCH_SIZE_INVALID');
    const r2 = rig();
    const createdOnly = expectValue(await create(r2)).attempt.attemptId;
    expect(expectError(await new IngestResponseEventsHandler(r2.deps).handle({ attemptId: createdOnly, events: [wire(createdOnly, 1)] }, ctx())).code).toBe('ATTEMPT_NOT_ACCEPTING_RESPONSES');
    expect(expectError(await handler.handle({ attemptId, events: [wire(attemptId, 1)] }, ctx('learner', id(TAG.student, 5)))).kind).toBe('NotFound');
  });

  it('refuses an id reused with other content in the batch, alone, naming it, and records the rest', async () => {
    const r = rig();
    const attemptId = await started(r);
    const handler = new IngestResponseEventsHandler(r.deps);
    const first = wire(attemptId, 1);
    expectValue(await handler.handle({ attemptId, events: [first] }, ctx()));
    const report = expectValue(await handler.handle({ attemptId, events: [{ ...wire(attemptId, 5, 'leave'), eventId: first.eventId }, wire(attemptId, 2), wire(attemptId, 2)] }, ctx()));
    expect(report.results.map((result) => result.outcome)).toEqual(['rejected', 'accepted', 'replayed']);
    expect(report.results[0]).toMatchObject({ code: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT' });
  });

  it('fails the whole batch, retryably, only when the store itself fails — reading the log, or writing an event', async () => {
    const r = rig();
    const attemptId = await started(r);
    const handler = new IngestResponseEventsHandler(r.deps);
    r.responses.findByAttempt = async () => err(conflictError('CONFLICT', 'down', 'x'));
    expect(expectError(await handler.handle({ attemptId, events: [wire(attemptId, 1)] }, ctx())).code).toBe('CONFLICT');

    const w = rig();
    const writeId = await started(w);
    w.responses.append = async () => err({ kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'the store could not be reached; try again' });
    expect(expectError(await new IngestResponseEventsHandler(w.deps).handle({ attemptId: writeId, events: [wire(writeId, 1)] }, ctx())).code).toBe('STORE_UNAVAILABLE');
  });

  it('turns a write the store refuses for this event alone — a conflict, or an attempt that stopped taking responses — into that event\'s answer', async () => {
    const r = rig();
    const attemptId = await started(r);
    r.responses.append = async (event) =>
      event.sequence === 1
        ? err(conflictError('CONFLICT', 'an event with this id was already recorded with different content', 'eventId'))
        : err({ kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'assessment_attempt_not_accepting_responses: attempt is abandoned', location: 'x' });
    const report = expectValue(await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [wire(attemptId, 1), wire(attemptId, 2)] }, ctx()));
    expect(report.results).toEqual([
      expect.objectContaining({ outcome: 'rejected', code: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT' }),
      expect.objectContaining({ outcome: 'rejected', code: 'ATTEMPT_NOT_ACCEPTING_RESPONSES' }),
    ]);
    expect(report.acknowledged).toEqual([]);
  });
});

describe('SubmitAttempt', () => {
  const submit = (r: ReturnType<typeof rig>, attemptId: string, reason: 'manual' | 'expiry' | 'recovered' = 'manual', key = 'sub', context = ctx()) =>
    new SubmitAttemptHandler(r.deps).handle({ attemptId, reason, idempotencyKey: key }, context);

  it('submits, audits once, and is idempotent on the key', async () => {
    const r = rig();
    const attemptId = await started(r);
    const first = expectValue(await submit(r, attemptId));
    expect(first).toMatchObject({ state: 'submitted', submission: { reason: 'manual', pastDeadline: false } });
    r.clock.at = '2026-10-21T10:00:00.000Z';
    expect(expectValue(await submit(r, attemptId)).submission?.submittedAt).toBe(first.submission?.submittedAt);
    expect(r.recorded.filter((entry) => entry.action === 'SubmitAttempt')).toHaveLength(1);
    expect(expectError(await submit(r, attemptId, 'manual', 'other')).code).toBe('ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY');
  });

  it('refuses an expiry before the deadline, accepts one after it, and marks a late manual one without relabelling it', async () => {
    const r = rig();
    const attemptId = await started(r);
    expect(expectError(await submit(r, attemptId, 'expiry')).code).toBe('SUBMISSION_EXPIRY_BEFORE_DEADLINE');
    r.clock.at = '2026-10-21T12:00:00.000Z';
    expect(expectValue(await submit(r, attemptId, 'expiry')).submission).toMatchObject({ reason: 'expiry', pastDeadline: true });

    const late = rig();
    const lateId = await started(late);
    late.clock.at = '2026-10-21T13:00:00.000Z';
    expect(expectValue(await submit(late, lateId)).submission).toMatchObject({ reason: 'manual', pastDeadline: true });
  });

  it('refuses another student\'s attempt, an attempt that has not started, and an invalid submission', async () => {
    const r = rig();
    const attemptId = expectValue(await create(r)).attempt.attemptId;
    expect(expectError(await submit(r, attemptId, 'manual', 'k', ctx('learner', id(TAG.student, 9)))).kind).toBe('NotFound');
    expect(expectError(await submit(r, attemptId)).code).toBe('ATTEMPT_TRANSITION_PROHIBITED');
    expect(expectError(await submit(r, attemptId, 'manual', '   ')).code).toBe('ATTEMPT_SUBMISSION_INVALID');
  });

  describe('when the write loses a race', () => {
    it('answers with the submission a racing request under the same key made', async () => {
      const r = rig();
      const attemptId = await started(r);
      const real = r.attempts.save.bind(r.attempts);
      r.attempts.save = async (attempt, expected) => {
        await real(attempt, expected);
        return err(conflictError('CONFLICT', 'the attempt moved', 'state'));
      };
      expect(expectValue(await submit(r, attemptId)).state).toBe('submitted');
    });

    it('refuses when the racing submission was under another key, and says so plainly when nothing moved', async () => {
      const r = rig();
      const attemptId = await started(r);
      const real = r.attempts.save.bind(r.attempts);
      r.attempts.save = async (attempt, expected) => {
        await real({ ...attempt, submission: { ...attempt.submission!, idempotencyKey: 'someone-elses' } }, expected);
        return err(conflictError('CONFLICT', 'the attempt moved', 'state'));
      };
      expect(expectError(await submit(r, attemptId)).code).toBe('ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY');

      const stuck = rig();
      const stuckId = await started(stuck);
      stuck.attempts.stale.add(stuckId);
      expect(expectError(await submit(stuck, stuckId)).code).toBe('CONFLICT');
    });
  });
});

describe('the paths the composed application used to be the only test of (M7-19)', () => {
  it('refuses to create an attempt the domain refuses, naming the field, before looking for an active mock', async () => {
    const r = rig();
    let asked = 0;
    const find = r.attempts.findActiveMock.bind(r.attempts);
    r.attempts.findActiveMock = async (studentId) => {
      asked += 1;
      return find(studentId);
    };
    const refused = expectError(await new CreateAttemptHandler(r.deps).handle({ formId: FORM.formId, sessionRef: SESSION_REF, shiftId: ' ', idempotencyKey: 'blank-shift' }, ctx()));
    expect(refused.kind).toBe('Validation');
    expect(refused.location).toBe('shiftId');
    expect(asked).toBe(0);
  });

  it('records an event that reaches the server after submission as late, and one before it as accepted', async () => {
    const r = rig();
    const attemptId = await started(r);
    const ingest = new IngestResponseEventsHandler(r.deps);
    const before = expectValue(await ingest.handle({ attemptId, events: [wire(attemptId, 1)] }, ctx()));
    expect(before.results.map((e) => e.outcome)).toEqual(['accepted']);
    expectValue(await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 'sub' }, ctx()));
    const after = expectValue(await ingest.handle({ attemptId, events: [wire(attemptId, 2, 'leave')] }, ctx()));
    expect(after.results.map((e) => e.outcome)).toEqual(['late']);
  });
});

