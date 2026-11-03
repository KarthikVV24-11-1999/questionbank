import { describe, expect, it } from 'vitest';
import { aRig, attemptWithLogDto, stored } from '../testing/fakes.js';
import { AttemptSession } from './attempt-session.js';
import type { SessionRecord } from './persistence.js';

/**
 * When an answer is on disk, and what is done until it is (M8-15, closes D66). The disk is held, released and failed by the test, so each of these is a statement about the order of
 * things: the screen first, the commit next, the sending only after.
 */
const START = { formId: 'form-1', attemptId: 'att-1', deviceRef: 'device-a', intervalCapMs: 90_000, deadline: '2026-10-21T11:30:00.000Z', serverNow: '2026-10-21T08:30:00.000Z' };

function begin() {
  const rig = aRig();
  return { ...rig, session: AttemptSession.begin(START, rig.ports) };
}

describe('the screen does not wait for the disk', () => {
  it('shows an answer at once while every commit is still out, and counts it as not yet saved', async () => {
    const { session, records } = begin();
    records.hold();
    session.goTo('q1');
    session.select('q1', 'b');
    const snapshot = session.getSnapshot();
    expect(snapshot.projection.slots.find((slot) => slot.slot === 'q1')?.answer).toBe('b');
    expect(snapshot).toMatchObject({ unsaved: 2, pending: 0, storageError: null });
    records.release();
    await session.saved();
    expect(session.getSnapshot()).toMatchObject({ unsaved: 0, pending: 2 });
  });

  it('keeps taps coming while a commit is out: they go together in the next, not one commit each', async () => {
    const { session, records } = begin();
    records.hold();
    session.goTo('q1');
    for (const answer of ['a', 'b', 'c', 'd', 'a', 'b']) session.select('q1', answer);
    records.release();
    await session.saved();
    expect(records.commits.length).toBeLessThanOrEqual(3); // begin, the first tap's, and everything after it
    expect(records.peek('att-1')!.events).toHaveLength(7);
  });
});

describe('nothing is sent until it is on disk', () => {
  it('holds a send while the commit is out, and sends exactly what the commit holds once it lands', async () => {
    const { session, records, transport } = begin();
    records.hold();
    session.goTo('q1');
    session.select('q1', 'a');
    const pumped = session.pump();
    await records.settle();
    expect(transport.sends).toEqual([]);
    records.release();
    await pumped;
    expect(transport.sends).toEqual([['ev-1', 'ev-2']]);
  });

  it('never lets the server hold an event the device would forget: at every step, what the server has is in what the disk has', async () => {
    const { session, records, transport, clock } = begin();
    const serverHoldsOnlyWhatTheDiskDoes = () => {
      const onDisk = new Set(records.peek('att-1')?.events.map((event) => event.eventId));
      for (const id of transport.stored.keys()) expect(onDisk.has(id), `${id} reached the server before the disk`).toBe(true);
    };
    session.goTo('q1');
    for (const [step, answer] of ['a', 'b', 'c', 'd', 'a', 'b', 'c'].entries()) {
      if (step % 2 === 0) records.hold();
      session.select('q1', answer);
      clock.advance(1_000);
      const pumped = session.pump();
      await records.settle();
      serverHoldsOnlyWhatTheDiskDoes();
      records.release();
      await pumped;
      serverHoldsOnlyWhatTheDiskDoes();
    }
    expect(transport.stored.size).toBe(8); // the visit and seven answers
  });

  it('loses nothing the server has when the browser dies with a commit out: the device is behind the server by nothing', async () => {
    const { session, records, transport } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    await session.pump(); // on disk, then sent
    records.hold();
    session.select('q1', 'b'); // given, shown, and in a commit that never comes back
    void session.pump();
    await records.settle();
    // the browser is killed here. A new run reads the disk.
    const restart = aRig({ records, newId: () => `after-${Math.random()}` });
    const record = records.peek('att-1')!;
    const resumed = AttemptSession.resume({ record, server: attemptWithLogDto({ events: [...transport.stored.values()] as never }) }, restart.ports);
    expect(record.events.map((event) => event.eventId)).toEqual(['ev-1', 'ev-2']);
    expect([...transport.stored.keys()]).toEqual(['ev-1', 'ev-2']); // the answer 'b' reached neither, and neither claims it
    expect(resumed.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')?.answer).toBe('a');
  });
});

describe('when the device cannot keep the log', () => {
  it('keeps the answer, says the device is not keeping it, and sends it as it is given', async () => {
    const { session, records, transport } = begin();
    records.failWith = new Error('QuotaExceededError');
    session.goTo('q1');
    session.select('q1', 'b');
    await session.saved();
    expect(session.getSnapshot()).toMatchObject({ storageError: 'QuotaExceededError', unsaved: 0, pending: 2 });
    expect(session.getSnapshot().projection.slots.find((slot) => slot.slot === 'q1')?.answer).toBe('b');
    await session.pump();
    expect(transport.sends.flat()).toEqual(['ev-1', 'ev-2']);
    // from here on an answer is sent at once, not held for a disk that is not answering
    session.select('q1', 'c');
    expect(session.getSnapshot()).toMatchObject({ unsaved: 0, pending: 1 });
  });

  it('says it in words when the error carries none', async () => {
    const { session, records } = begin();
    records.failWith = Object.assign(new Error(''), { name: 'Blocked' });
    session.goTo('q1');
    await session.saved();
    expect(session.getSnapshot().storageError).toBe('this device could not keep the answers');
    records.failWith = 'not an error' as never;
    session.goTo('q2');
    await session.saved();
    expect(session.getSnapshot().storageError).toBe('this device could not keep the answers');
  });

  it('tries the disk again at every pump, even when there is nothing to send, and stops saying so when it takes the log', async () => {
    const { session, records, clock } = begin();
    records.failWith = new Error('blocked');
    session.goTo('q1');
    await session.saved();
    await session.pump(); // sends the visit it could not keep; the disk is still refusing
    expect(session.getSnapshot()).toMatchObject({ storageError: 'blocked', pending: 0 });
    records.failWith = null;
    clock.advance(1_000);
    await session.pump(); // nothing to send and nothing changed: only the retry can bring the record to disk
    await session.saved();
    expect(session.getSnapshot().storageError).toBeNull();
    expect(records.peek('att-1')!.events).toHaveLength(1);
  });
});

describe('handing the paper in', () => {
  it('goes once every answer is on disk and sent', async () => {
    const { session, transport } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    await session.submit('manual');
    expect(transport.sends.flat()).toEqual(['ev-1', 'ev-2']);
    expect(transport.submissions).toHaveLength(1);
    expect(session.getSnapshot().phase).toBe('submitted');
  });

  it('does not go while answers behind it are not yet on disk, and goes without them when the disk has not answered in the grace it was given', async () => {
    const { session, records, transport, clock } = begin();
    session.goTo('q1');
    session.select('q1', 'a');
    await session.pump();
    records.hold();
    session.select('q1', 'b');
    void session.submit('manual'); // taken at once; waits on the disk
    await records.settle();
    expect(session.getSnapshot()).toMatchObject({ phase: 'submitting', unsaved: 1 });
    await session.pump();
    expect(transport.submissions).toEqual([]);
    clock.advance(4_999);
    await session.pump();
    expect(transport.submissions).toEqual([]);
    clock.advance(1);
    await session.pump();
    expect(transport.sends.flat()).toEqual(['ev-1', 'ev-2', 'ev-3']); // the unsaved answer went, as it was
    expect(transport.submissions).toHaveLength(1);
    expect(session.getSnapshot().phase).toBe('submitted');
  });

  it('honours the grace the ports give it', async () => {
    const rig = aRig({ durabilityGraceMs: 100 });
    const session = AttemptSession.begin(START, rig.ports);
    session.goTo('q1');
    rig.records.hold();
    session.select('q1', 'b');
    void session.submit('manual');
    await rig.records.settle();
    await session.pump();
    rig.clock.advance(100);
    await session.pump();
    expect(rig.transport.submissions).toHaveLength(1);
  });
});

describe('what the session tells the outside of what it keeps', () => {
  it('hands each record it means to keep to the observer, in memory and at once', async () => {
    const seen: SessionRecord[] = [];
    const rig = aRig({ observe: (record) => void seen.push(record) });
    const session = AttemptSession.begin(START, rig.ports);
    session.goTo('q1');
    expect(seen.map((record) => record.events.length)).toEqual([0, 1]);
    await session.saved();
  });

  it('resumes from a record without writing it again, and writes only what the resume adds', async () => {
    const first = begin();
    first.session.goTo('q1');
    first.session.select('q1', 'b');
    await first.session.pump();
    const committed = first.records.commits.length;
    const rig = aRig({ records: first.records, newId: () => `r-${Math.random()}` });
    const resumed = AttemptSession.resume({ record: (await stored(first, 'att-1'))!, server: attemptWithLogDto() }, rig.ports);
    await resumed.saved();
    expect(first.records.commits).toHaveLength(committed + 1);
    expect(first.records.commits.at(-1)!.rows.map((row) => row.event.kind)).toEqual(['visit']); // the revisit, and nothing already there
  });
});
