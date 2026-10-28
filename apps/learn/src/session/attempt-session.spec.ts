import { describe, expect, it } from 'vitest';
import { attemptDto, aRig } from '../testing/fakes.js';
import { AttemptSession } from './attempt-session.js';
import { loadRecord } from './persistence.js';

const START = {
  attemptId: 'att-1',
  deviceRef: 'device-a',
  intervalCapMs: 90_000,
  deadline: '2026-10-21T11:30:00.000Z',
  serverNow: '2026-10-21T08:30:00.000Z',
};
const THREE_HOURS = 3 * 3_600_000;

function begin(overrides: Parameters<typeof aRig>[0] = {}, start = START) {
  const rig = aRig(overrides);
  return { ...rig, session: AttemptSession.begin(start, rig.ports) };
}

describe('beginning an attempt', () => {
  it('holds a fresh engine attempt: nothing answered, nothing unsent, the time the server left', () => {
    const { session } = begin();
    const snapshot = session.getSnapshot();
    expect(snapshot).toMatchObject({ attemptId: 'att-1', phase: 'in_progress', currentSlot: null, pending: 0, rejected: 0, sync: 'idle', submission: null, result: null, submissionNote: null });
    expect(snapshot.remainingMs).toBe(THREE_HOURS);
    expect(snapshot.projection.slots).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('is told the cap and uses it: it is the one the projection runs under, and no other', () => {
    const run = (intervalCapMs: number) => {
      const { session, clock } = begin({}, { ...START, intervalCapMs });
      session.goTo('q1');
      clock.advance(200_000);
      session.leave();
      return session.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')?.timeOnItemMs;
    };
    expect(run(90_000)).toBe(90_000);
    expect(run(150_000)).toBe(150_000);
    expect(run(500_000)).toBe(200_000);
    expect(begin().session.getSnapshot().intervalCapMs).toBe(90_000);
  });

  it('writes itself down at once, so a reload finds it', () => {
    const { storage } = begin();
    expect(loadRecord(storage, 'att-1')).toMatchObject({ attemptId: 'att-1', deadline: START.deadline, intervalCapMs: 90_000, events: [], submissionReason: null });
  });
});

describe('what the learner does is the engine\'s log, and what is shown is derived from it', () => {
  it('records a visit and a leave as events, and knows the question on screen from the log alone', () => {
    const { session } = begin();
    expect(session.getSnapshot().currentSlot).toBeNull();
    session.goTo('q1');
    expect(session.getSnapshot().currentSlot).toBe('q1');
    session.goTo('q1'); // already there: nothing recorded
    session.goTo('q2'); // leaves q1, visits q2
    expect(session.getSnapshot().currentSlot).toBe('q2');
    session.leave();
    expect(session.getSnapshot().currentSlot).toBeNull();
    session.leave(); // nothing open: nothing recorded
    const kinds = (loadRecordEvents(session) as { kind: string; slot: string }[]).map((event) => `${event.kind}:${event.slot}`);
    expect(kinds).toEqual(['visit:q1', 'leave:q1', 'visit:q2', 'leave:q2']);
  });

  it('records the first answer as a select and a later one as a change, and clearing as a clear', () => {
    const { session } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    session.select('q1', 'b');
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')).toMatchObject({ answer: 'b', answerChanges: 1 });
    session.clear('q1');
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')?.answer).toBeNull();
    session.select('q1', ['a', 'c']);
    expect((loadRecordEvents(session) as { kind: string }[]).map((event) => event.kind)).toEqual(['visit', 'select', 'change', 'clear', 'select']);
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')?.answer).toEqual(['a', 'c']);
  });

  it('flags and unflags a question, and reads the flag from the log', () => {
    const { session } = begin();
    expect(session.isFlagged('q1')).toBe(false);
    session.flag('q1', true);
    expect(session.isFlagged('q1')).toBe(true);
    session.flag('q1', false);
    expect(session.isFlagged('q1')).toBe(false);
  });

  it('records a skip as an event of its own, which is not an answer and is withdrawn by answering', () => {
    const { session } = begin();
    session.goTo('q1');
    session.skip('q1');
    const slot = () => session.getSnapshot().projection.slots.find((entry) => entry.slot === 'q1');
    expect(slot()).toMatchObject({ skipped: true, answer: null });
    session.select('q1', 'a');
    expect(slot()).toMatchObject({ skipped: false, answer: 'a' });
    expect((loadRecordEvents(session) as { kind: string }[]).map((event) => event.kind)).toEqual(['visit', 'skip', 'select']);
  });

  it('numbers events in the log\'s own order and stamps them with the monotonic reading, never a wall-clock time', () => {
    const { session, clock } = begin();
    session.goTo('q1');
    clock.advance(2_500);
    session.select('q1', 'a');
    const events = loadRecordEvents(session) as { sequence: number; monotonicMs: number; eventId: string }[];
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.monotonicMs)).toEqual([1_000, 3_500]);
    expect(events.map((event) => event.eventId)).toEqual(['ev-1', 'ev-2']);
  });

  it('notifies its listeners of every change, and stops when told to', () => {
    const { session } = begin();
    let calls = 0;
    const stop = session.subscribe(() => void (calls += 1));
    session.goTo('q1');
    session.select('q1', 'a');
    expect(calls).toBe(2);
    stop();
    session.goTo('q2');
    expect(calls).toBe(2);
  });

  it('gives the same snapshot until something changes', () => {
    const { session } = begin();
    const first = session.getSnapshot();
    expect(session.getSnapshot()).toBe(first);
    session.goTo('q1');
    expect(session.getSnapshot()).not.toBe(first);
  });
});

function loadRecordEvents(session: AttemptSession): unknown[] {
  // the session persists after every change: what the disk holds is the engine's log
  const holder = session as unknown as { ports: { storage: { getItem(key: string): string | null } } };
  return (JSON.parse(holder.ports.storage.getItem('qb.attempt.att-1') as string) as { events: unknown[] }).events;
}

describe('sending what was captured', () => {
  it('sends the queue in order, marks it acknowledged, and says it is synced — the engine\'s word for it', async () => {
    const { session, transport } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    expect(session.getSnapshot()).toMatchObject({ pending: 2, sync: 'pending' });
    await session.pump();
    expect(transport.sends).toEqual([['ev-1', 'ev-2']]);
    expect(session.getSnapshot()).toMatchObject({ pending: 0, sync: 'idle' });
  });

  it('holds everything through an outage, backs off calmly, and drains when the network returns', async () => {
    const { session, transport, clock } = begin();
    transport.online = false;
    session.goTo('q1');
    session.select('q1', 'a');
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ pending: 2, sync: 'backing_off', rejected: 0 });
    // nothing is sent while backing off, however often it is asked
    clock.advance(10);
    await session.pump();
    expect(transport.sends).toEqual([]);

    // answers keep being captured through the outage
    session.select('q1', 'b');
    session.goTo('q2');
    expect(session.getSnapshot().pending).toBe(5);

    transport.online = true;
    clock.advance(5_000);
    await session.pump();
    expect(transport.sends.flat()).toEqual(['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5']);
    expect(session.getSnapshot()).toMatchObject({ pending: 0, sync: 'idle' });
    expect([...transport.stored.keys()]).toEqual(['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5']);
  });

  it('sends at once when asked, forgetting the back-off', async () => {
    const { session, transport } = begin();
    transport.online = false;
    session.goTo('q1');
    await session.pump();
    expect(session.getSnapshot().sync).toBe('backing_off');
    transport.online = true;
    await session.syncNow();
    expect(session.getSnapshot()).toMatchObject({ pending: 0, sync: 'idle' });
  });

  it('suspends after enough failures in a row, and a person\'s retry wakes it', async () => {
    const { session, transport, clock } = begin({ syncPolicy: { batchSize: 10, baseDelayMs: 1, maxDelayMs: 1, maxConsecutiveFailures: 2 } });
    transport.online = false;
    session.goTo('q1');
    await session.pump();
    clock.advance(5);
    await session.pump();
    expect(session.getSnapshot().sync).toBe('suspended');
    transport.online = true;
    await session.syncNow();
    expect(session.getSnapshot().sync).toBe('idle');
  });

  it('does not retry an event the server refused for good, counts it, and does not let it block the rest', async () => {
    const { session, transport } = begin();
    transport.refuseEventIds = new Set(['ev-1']);
    session.goTo('q1');
    session.select('q1', 'a');
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ pending: 0, rejected: 1, sync: 'idle' });
    await session.pump();
    expect(transport.sends).toEqual([['ev-1', 'ev-2']]);
  });

  it('stops asking in a loop when the server says nothing about any of them', async () => {
    const { session, transport } = begin();
    transport.acknowledgeNothing = true;
    session.goTo('q1');
    await session.pump();
    expect(transport.sends).toHaveLength(1);
    expect(session.getSnapshot().pending).toBe(1);
  });

  it('does not run two sends at once', async () => {
    const { session, transport } = begin();
    session.goTo('q1');
    await Promise.all([session.pump(), session.pump(), session.syncNow()]);
    expect(transport.sends).toHaveLength(1);
  });
});

describe('time, and the deadline (M6-50)', () => {
  it('counts down against the monotonic clock only', async () => {
    const { session, clock } = begin();
    clock.advance(60_000);
    expect(session.getSnapshot().remainingMs).toBe(THREE_HOURS - 60_000);
    await session.pump();
    clock.advance(60_000);
    expect(session.getSnapshot().remainingMs).toBe(THREE_HOURS - 120_000);
  });

  it('submits at the deadline with the reason expiry — after sending what was unsent — and not before', async () => {
    const { session, clock, transport } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    clock.advance(THREE_HOURS - 1);
    await session.pump();
    expect(session.getSnapshot().phase).toBe('in_progress');
    transport.serverRemainingMs = 0; // the server's clock agrees that the time is up
    clock.advance(1);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', submission: { reason: 'expiry' }, pending: 0 });
    expect(transport.submissions).toEqual([{ reason: 'expiry', key: 'submission:att-1' }]);
    expect(transport.sends.flat()).toEqual(['ev-1', 'ev-2']);
  });

  it('refuses any more responses once submitted: the engine takes none, and the log is as it was', async () => {
    const { session } = begin();
    session.goTo('q1');
    await session.submit('manual');
    const before = session.getSnapshot().projection;
    session.select('q1', 'a');
    session.goTo('q2');
    session.clear('q1');
    expect(session.getSnapshot().projection).toEqual(before);
  });

  it('keeps the submission it started through an outage at the deadline, and finishes it when the network returns', async () => {
    const { session, clock, transport } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    transport.online = false;
    clock.advance(THREE_HOURS);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitting', submission: { reason: 'expiry' }, pending: 2 });

    transport.online = true;
    clock.advance(30_000);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', pending: 0 });
    expect(transport.submissions).toHaveLength(1);
  });

  it('tries again when the server is not yet willing to take an expiry, and says why meanwhile', async () => {
    const { session, clock, transport } = begin();
    transport.refuseSubmissionUntil = 1;
    transport.serverRemainingMs = 0;
    clock.advance(THREE_HOURS);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitting', submissionNote: expect.stringContaining('deadline') });
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', submissionNote: null });
  });

  it('describes a refusal that is not an Error in words', async () => {
    const { session, transport } = begin();
    transport.submit = async () => {
      throw 'plain text';
    };
    await session.submit('manual');
    expect(session.getSnapshot().submissionNote).toBe('the submission has not reached the server yet');
  });

  it('submits manually on request, once: a second ask changes nothing and sends nothing more', async () => {
    const { session, transport } = begin();
    await session.submit('manual');
    await session.submit('manual');
    await session.submit('expiry');
    expect(transport.submissions).toEqual([{ reason: 'manual', key: 'submission:att-1' }]);
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', submission: { reason: 'manual' } });
  });

  it('keeps trying a submission that is waiting on the queue, from a pump and from a retry', async () => {
    const { session, transport, clock } = begin();
    session.goTo('q1');
    transport.online = false;
    await session.submit('manual');
    expect(session.getSnapshot().phase).toBe('submitting');
    transport.online = true;
    await session.syncNow();
    expect(session.getSnapshot().phase).toBe('submitted');
    clock.advance(1);
    await session.pump();
    expect(transport.submissions).toHaveLength(1);
  });
});

describe('the result', () => {
  it('is fetched once submitted, and shown as the server gave it', async () => {
    const { session, transport } = begin();
    await session.refreshResult();
    expect(session.getSnapshot().result).toBeNull();
    await session.submit('manual');
    await session.refreshResult();
    expect(session.getSnapshot().result).toEqual({ attemptId: 'att-1', status: 'pending' });
    transport.resultAnswer = { attemptId: 'att-1', status: 'scored', score: { scoreRecordId: 's', attemptId: 'att-1', generation: 1, totalRaw: '10', totalMaxAvailable: '24', computedAt: 't', sectionScores: [], itemOutcomes: [] } };
    await session.refreshResult();
    expect(session.getSnapshot().result?.status).toBe('scored');
  });

  it('says nothing when it could not be fetched: the screen goes on saying pending', async () => {
    const { session, transport } = begin();
    await session.submit('manual');
    transport.resultAnswer = new Error('unreachable');
    await session.refreshResult();
    expect(session.getSnapshot().result).toBeNull();
  });
});

describe('resuming after a reload (M6-50)', () => {
  it('rebuilds the engine\'s state from what was written, and takes the deadline from the server, not from a restart', async () => {
    const first = begin();
    first.session.goTo('q1');
    first.session.select('q1', 'a');
    first.session.select('q1', 'b');
    await first.session.pump(); // all acknowledged

    // an hour later the app is opened again: a new run, a new monotonic origin, the same storage
    let later = 100;
    const reloaded = aRig({ storage: first.storage, newId: () => `after-reload-${(later += 1)}` });
    reloaded.clock.reading = 5;
    const record = loadRecord(first.storage, 'att-1')!;
    const resumed = AttemptSession.resume({ record, server: attemptDto({ serverNow: '2026-10-21T09:30:00.000Z' }) }, reloaded.ports);
    const snapshot = resumed.getSnapshot();
    expect(snapshot.remainingMs).toBe(2 * 3_600_000);
    expect(snapshot.projection.slots.find((slot) => slot.slot === 'q1')).toMatchObject({ answer: 'b', answerChanges: 1 });
    expect(snapshot.currentSlot).toBe('q1');
    expect(snapshot).toMatchObject({ phase: 'in_progress', pending: 1, intervalCapMs: 90_000 }); // the revisit is the one thing unsent
    // and it carries on numbering where the log left off
    resumed.select('q1', 'c');
    // (the question that was open is visited again on resume — see the time-on-item spec — so the next event is the fifth)
    expect(loadRecord(first.storage, 'att-1')!.events.at(-1)).toMatchObject({ sequence: 5, kind: 'change', answer: 'c' });
  });

  it('does not send again what the server already has, and sends what it did not', async () => {
    const first = begin();
    first.session.goTo('q1');
    await first.session.pump();
    first.transport.online = false;
    first.session.select('q1', 'a'); // captured, never sent

    const reloaded = aRig({ storage: first.storage });
    const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptDto() }, reloaded.ports);
    expect(resumed.getSnapshot().pending).toBe(1);
    await resumed.pump();
    expect(reloaded.transport.sends).toEqual([['ev-2']]);
  });

  it('does not send again an event the server refused for good', () => {
    const first = begin();
    first.transport.refuseEventIds = new Set(['ev-1']);
    first.session.goTo('q1');
    return first.session.pump().then(() => {
      const reloaded = aRig({ storage: first.storage });
      const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptDto() }, reloaded.ports);
      expect(resumed.getSnapshot()).toMatchObject({ pending: 0, rejected: 1 });
    });
  });

  it('resumes a submission that was started and not finished, and finishes it', async () => {
    const first = begin();
    first.session.goTo('q1');
    first.transport.online = false;
    await first.session.submit('manual');
    expect(first.session.getSnapshot().phase).toBe('submitting');

    const reloaded = aRig({ storage: first.storage });
    const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptDto() }, reloaded.ports);
    expect(resumed.getSnapshot()).toMatchObject({ phase: 'submitting', submission: { reason: 'manual' } });
    await resumed.pump();
    expect(resumed.getSnapshot().phase).toBe('submitted');
    expect(reloaded.transport.submissions).toEqual([{ reason: 'manual', key: 'submission:att-1' }]);
  });

  it('resumes into submitted when the server already has the submission, with what it recorded as the reason', async () => {
    const first = begin();
    const record = loadRecord(first.storage, 'att-1')!;
    const server = attemptDto({ state: 'submitted', submission: { reason: 'expiry', submittedAt: 't', pastDeadline: true } });
    const resumed = AttemptSession.resume({ record, server }, aRig({ storage: first.storage }).ports);
    expect(resumed.getSnapshot()).toMatchObject({ phase: 'submitted', submission: { reason: 'expiry' } });
    const noSubmission = AttemptSession.resume({ record, server: attemptDto({ state: 'submitted' }) }, aRig({ storage: first.storage }).ports);
    expect(noSubmission.getSnapshot().submission).toEqual({ reason: 'manual' });
  });

  it('falls back to the record\'s deadline if the server reports none', () => {
    const first = begin();
    const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptDto({ deadline: null, serverNow: '2026-10-21T10:30:00.000Z' }) }, aRig({ storage: first.storage }).ports);
    expect(resumed.getSnapshot().remainingMs).toBe(3_600_000);
  });

  it('refuses a stored log that does not rebuild, rather than carrying on from half of it', () => {
    const first = begin();
    const record = loadRecord(first.storage, 'att-1')!;
    const regressed = { ...record, events: [
      { eventId: 'x1', attemptId: 'att-1', slot: 'q1', sequence: 5, monotonicMs: 1, kind: 'visit' as const },
      { eventId: 'x2', attemptId: 'att-1', slot: 'q1', sequence: 3, monotonicMs: 2, kind: 'leave' as const },
    ] };
    expect(() => AttemptSession.resume({ record: regressed, server: attemptDto() }, aRig().ports)).toThrow('sequence_regression');
  });
});
