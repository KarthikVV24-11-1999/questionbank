import { describe, expect, it } from 'vitest';
import { aRig, attemptDto, attemptWithLogDto } from '../testing/fakes.js';
import { AttemptSession } from './attempt-session.js';
import { loadRecord } from './persistence.js';

/**
 * The clock-skew and outage halves of the adversarial criteria (M6-55, M6-56), against the session with time and the network supplied.
 * The kills are in `tools/adversarial`, in a real browser; what runs here is what a browser cannot be made to do on demand (a monotonic
 * clock that jumps) and what does not need one.
 */
const START = { attemptId: 'att-1', formId: 'form-1', deviceRef: 'd', intervalCapMs: 90_000, deadline: '2026-10-21T11:30:00.000Z', serverNow: '2026-10-21T08:30:00.000Z' };
const THREE_HOURS = 3 * 3_600_000;
const SLOT = 'q1';

function begin() {
  const rig = aRig();
  return { ...rig, session: AttemptSession.begin(START, rig.ports) };
}

describe('the device clock jumps (M6-55)', () => {
  it('a wall clock set forward or back changes nothing: the session reads no wall clock, only the monotonic one it is handed', async () => {
    const { session, clock } = begin();
    const realNow = Date.now;
    try {
      for (const shift of [5 * 3_600_000, -5 * 3_600_000, 86_400_000]) {
        Date.now = () => realNow() + shift;
        clock.advance(60_000);
        await session.pump();
      }
    } finally {
      Date.now = realNow;
    }
    expect(session.getSnapshot()).toMatchObject({ phase: 'in_progress', remainingMs: THREE_HOURS - 180_000 });
  });

  it('a monotonic reading that goes backwards counts nothing, so it cannot extend the deadline', async () => {
    const { session, clock } = begin();
    clock.advance(600_000);
    await session.pump();
    const before = session.getSnapshot().remainingMs;
    clock.reading -= 400_000; // a clock that went back
    await session.pump();
    expect(session.getSnapshot().remainingMs).toBe(before);
    clock.advance(1_000); // and carries on from where it now is
    await session.pump();
    expect(session.getSnapshot().remainingMs).toBe(before - 1_000);
  });

  it('a monotonic jump forward past the deadline does not end the attempt: the server is asked, says time remains, and the timer takes its word', async () => {
    const { session, clock, transport } = begin();
    session.goTo(SLOT);
    session.select(SLOT, 'a');
    clock.advance(THREE_HOURS + 600_000); // the device thinks the time is long gone
    transport.serverRemainingMs = 2_400_000; // the server says forty minutes are left
    await session.pump();
    const snapshot = session.getSnapshot();
    expect(snapshot).toMatchObject({ phase: 'in_progress', submission: null });
    expect(snapshot.remainingMs).toBe(2_400_000);
    expect(transport.submissions).toEqual([]);
    // the learner can still answer, and the answer goes through
    session.select(SLOT, 'b');
    await session.pump();
    expect([...transport.stored.values()].map((event) => (event as { kind: string }).kind)).toContain('change');
  });

  it('and once the server agrees the time is up, it submits as expiry', async () => {
    const { session, clock, transport } = begin();
    clock.advance(THREE_HOURS + 600_000);
    transport.serverRemainingMs = 2_400_000;
    await session.pump();
    clock.advance(2_400_000);
    transport.serverRemainingMs = 0;
    await session.pump();
    expect(transport.submissions).toEqual([{ reason: 'expiry', key: 'submission:att-1' }]);
  });

  it('the server being unreachable at the deadline does not hold the learner past it: the local timer stands and the submission waits to be sent', async () => {
    const { session, clock, transport } = begin();
    transport.online = false;
    clock.advance(THREE_HOURS);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitting', submission: { reason: 'expiry' } });
  });

  it('a server that has the attempt already submitted gets the expiry, which it takes as a replay', async () => {
    const { session, clock, transport } = begin();
    transport.getAttempt = async () => attemptWithLogDto({ state: 'submitted' });
    clock.advance(THREE_HOURS);
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', submission: { reason: 'expiry' } });
  });

  it('a clock that drifts is brought back to the server\'s at the deadline: a device running slow does not get the extra time', async () => {
    const { session, clock, transport } = begin();
    // the device's clock ran 5% slow all attempt long: it has counted 95% of the time the server has
    clock.advance(Math.round(THREE_HOURS * 0.95));
    await session.pump();
    transport.serverRemainingMs = 0; // the server's clock has the deadline reached
    clock.advance(Math.round(THREE_HOURS * 0.05));
    await session.pump();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitted', submission: { reason: 'expiry' } });
  });

  it('time on item is computed under the pinned cap, and a jump cannot inflate it beyond it', async () => {
    const { session, clock } = begin();
    session.goTo(SLOT);
    clock.advance(10 * 3_600_000); // the app was away for ten hours, or the clock jumped
    session.goTo('q2');
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === SLOT)?.timeOnItemMs).toBe(90_000);
    clock.reading -= 20 * 3_600_000; // and then it jumped back
    session.goTo(SLOT);
    session.leave();
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === SLOT)?.timeOnItemMs).toBe(90_000);
  });
});

describe('a question left open when the app dies (M6-54)', () => {
  it('is visited again on resume, so the time the app was not running is counted towards nothing', () => {
    const first = begin();
    first.session.goTo(SLOT);
    first.clock.advance(10_000);
    first.session.select(SLOT, 'a');

    // killed and reopened a long time later, on a new clock origin that happens to be far ahead of the old visit
    const reopened = aRig({ storage: first.storage, newId: () => `r-${Math.random()}` });
    reopened.clock.reading = 5_000_000;
    const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptWithLogDto() }, reopened.ports);
    reopened.clock.advance(7_000);
    resumed.leave();
    // without the revisit this interval would be 5,000,000 + 7,000 − 1,000 capped to 90,000; with it, only the seven seconds the app was open
    expect(resumed.getSnapshot().projection.slots.find((slot) => slot.slot === SLOT)?.timeOnItemMs).toBe(7_000);
  });

  it('does not touch an attempt that was between questions, or one already being submitted', async () => {
    const first = begin();
    first.session.goTo(SLOT);
    first.session.leave();
    const eventsBefore = loadRecord(first.storage, 'att-1')!.events.length;
    AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: attemptWithLogDto() }, aRig({ storage: first.storage }).ports);
    expect(loadRecord(first.storage, 'att-1')!.events).toHaveLength(eventsBefore);

    const second = begin();
    second.session.goTo(SLOT);
    second.transport.online = false;
    await second.session.submit('manual');
    const submitting = loadRecord(second.storage, 'att-1')!;
    AttemptSession.resume({ record: submitting, server: attemptWithLogDto() }, aRig({ storage: second.storage }).ports);
    expect(loadRecord(second.storage, 'att-1')!.events).toHaveLength(submitting.events.length);
  });
});

describe('the backend goes away and comes back (M6-56)', () => {
  it('every answer given through an outage is on the device, none is lost, and all of it drains when the backend returns', async () => {
    const { session, clock, transport, storage } = begin();
    session.goTo(SLOT);
    transport.online = false;
    const given: string[] = [];
    for (const answer of ['a', 'b', 'c', 'd', 'a']) {
      session.select(SLOT, answer);
      given.push(answer);
      clock.advance(1_000);
      await session.pump();
      expect(session.getSnapshot().sync).not.toBe('idle');
      expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === SLOT)?.answer).toBe(answer);
    }
    expect(loadRecord(storage, 'att-1')!.events.filter((event) => event.kind === 'select' || event.kind === 'change')).toHaveLength(given.length);
    expect(transport.stored.size).toBe(0);

    transport.online = true;
    await session.syncNow();
    expect(session.getSnapshot()).toMatchObject({ pending: 0 });
    expect(session.getSnapshot().sync).toBe('idle');
    expect([...transport.stored.values()].filter((event) => ['select', 'change'].includes((event as { kind: string }).kind))).toHaveLength(given.length);
  });
});
