import { describe, expect, it } from 'vitest';
import { MemoryRecords } from '../testing/fakes.js';
import type { SessionRecord } from './persistence.js';
import { RecordWriter } from './record-writer.js';

const event = (n: number) => ({ eventId: `e${n}`, attemptId: 'att-1', slot: 'q1', sequence: n, monotonicMs: n, kind: 'visit' as const });
const record = (count: number, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  attemptId: 'att-1',
  deviceRef: 'dev',
  intervalCapMs: 90_000,
  deadline: '2026-10-21T11:30:00.000Z',
  formId: 'form-1',
  serverOffsetMs: 0,
  submissionReason: null,
  events: Array.from({ length: count }, (_, i) => event(i + 1)),
  acknowledgedIds: [],
  rejectedIds: [],
  ...extra,
});

function rig() {
  const store = new MemoryRecords();
  const durable: string[][] = [];
  const failures: unknown[] = [];
  let recovered = 0;
  const writer = new RecordWriter(store, { onDurable: (ids) => void durable.push([...ids]), onFailure: (error) => void failures.push(error), onRecovered: () => void (recovered += 1) });
  return { store, writer, durable, failures, recovered: () => recovered };
}

describe('the record is written without anyone waiting for it, and only what changed is written (M8-15)', () => {
  it('commits the first record whole and reports its events durable only after the commit resolved', async () => {
    const { store, writer, durable } = rig();
    store.hold();
    writer.write(record(2));
    await store.settle();
    expect(durable).toEqual([]); // the commit is out and has not come back: nothing is on disk, and nothing is said to be
    expect(store.peek('att-1')).toBeNull();
    store.release();
    await writer.idle();
    expect(durable).toEqual([['e1', 'e2']]);
    expect(store.peek('att-1')!.events).toHaveLength(2);
  });

  it('keeps one commit in flight: ten changes made while it is out go together in the next', async () => {
    const { store, writer, durable } = rig();
    store.hold();
    writer.write(record(1));
    for (let n = 2; n <= 11; n += 1) writer.write(record(n));
    store.release();
    await writer.idle();
    expect(store.commits).toHaveLength(2);
    expect(store.commits[0]!.rows).toHaveLength(1);
    expect(store.commits[1]!.rows.map((row) => row.eventId)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11']);
    expect(durable).toEqual([['e1'], ['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11']]);
  });

  it('writes only the rows that are new or whose state changed, and the facts only when they changed', async () => {
    const { store, writer } = rig();
    writer.write(record(2));
    await writer.idle();
    writer.write(record(3));
    await writer.idle();
    writer.write(record(3, { acknowledgedIds: ['e1', 'e2'] }));
    await writer.idle();
    writer.write(record(3, { acknowledgedIds: ['e1', 'e2'], serverOffsetMs: 7 }));
    await writer.idle();
    expect(store.commits.map((commit) => commit.rows.map((row) => `${row.eventId}:${row.state}`))).toEqual([['e1:open', 'e2:open'], ['e3:open'], ['e1:acknowledged', 'e2:acknowledged'], []]);
    expect(store.commits.at(-1)!.meta.serverOffsetMs).toBe(7);
  });

  it('writes nothing for a change that is already on disk, and says nothing of it', async () => {
    const { store, writer, durable } = rig();
    writer.write(record(2));
    await writer.idle();
    writer.write({ ...record(2) });
    await writer.idle();
    expect(store.commits).toHaveLength(1);
    expect(durable).toHaveLength(1);
  });

  it('takes what was read from the disk as the baseline: it does not write it again', async () => {
    const { store, writer, durable } = rig();
    writer.adopt(record(2));
    writer.write(record(3));
    await writer.idle();
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]!.rows.map((row) => row.eventId)).toEqual(['e3']);
    expect(durable).toEqual([['e3']]);
    // adopted and unchanged: nothing is committed at all
    const again = rig();
    again.writer.adopt(record(2));
    again.writer.write(record(2));
    await again.writer.idle();
    expect(again.store.commits).toEqual([]);
  });

  it('is dirty from a change until it is on disk, and idle when asked at once', async () => {
    const { store, writer } = rig();
    await writer.idle();
    expect(writer.dirty).toBe(false);
    store.hold();
    writer.write(record(1));
    expect(writer.dirty).toBe(true);
    store.release();
    await writer.idle();
    expect(writer.dirty).toBe(false);
  });

  it('starts nothing when there is nothing to write', async () => {
    const { store, writer } = rig();
    writer.kick();
    await writer.idle();
    expect(store.commits).toEqual([]);
  });
});

describe('when the disk will not take a commit', () => {
  it('says so, stays dirty, writes nothing it has not written, and does not claim anything durable', async () => {
    const { store, writer, failures, durable } = rig();
    store.failWith = new Error('quota exceeded');
    writer.write(record(2));
    await writer.idle();
    expect(failures).toEqual([store.failWith]);
    expect(durable).toEqual([]);
    expect(writer.dirty).toBe(true);
    expect(store.peek('att-1')).toBeNull();
  });

  it('tries again at the next kick, and on success reports the events durable and the failure over', async () => {
    const { store, writer, failures, durable, recovered } = rig();
    store.failWith = new Error('quota exceeded');
    writer.write(record(2));
    await writer.idle();
    store.failWith = null;
    writer.kick();
    await writer.idle();
    expect(recovered()).toBe(1);
    expect(durable).toEqual([['e1', 'e2']]);
    expect(failures).toHaveLength(1);
    expect(writer.dirty).toBe(false);
  });

  it('tries again at the next change too, and reports recovery only once', async () => {
    const { store, writer, recovered } = rig();
    store.failWith = new Error('blocked');
    writer.write(record(1));
    await writer.idle();
    store.failWith = null;
    writer.write(record(2));
    await writer.idle();
    writer.write(record(3));
    await writer.idle();
    expect(recovered()).toBe(1);
    expect(store.peek('att-1')!.events).toHaveLength(3);
  });

  it('does not loop on a failing disk: one attempt per kick', async () => {
    const { store, writer, failures } = rig();
    store.failWith = new Error('blocked');
    writer.write(record(1));
    await writer.idle();
    writer.kick();
    await writer.idle();
    expect(failures).toHaveLength(2);
  });
});
