import { describe, expect, it } from 'vitest';
import { FakeIdb } from '../testing/fake-idb.js';
import { openDraftStore, openRecordStore, unavailableRecordStore } from './idb-record-store.js';
import { loadRecord, saveRecord, splitRecord, type SessionRecord } from './persistence.js';

const record: SessionRecord = {
  version: 1,
  attemptId: 'att-1',
  deviceRef: 'dev',
  intervalCapMs: 90_000,
  deadline: '2026-10-21T11:30:00.000Z',
  formId: 'form-1',
  serverOffsetMs: 12,
  submissionReason: null,
  events: [
    { eventId: 'e1', attemptId: 'att-1', slot: 'q1', sequence: 1, monotonicMs: 1, kind: 'visit' },
    { eventId: 'e2', attemptId: 'att-1', slot: 'q1', sequence: 2, monotonicMs: 2, kind: 'select', answer: 'b' },
  ],
  acknowledgedIds: ['e1'],
  rejectedIds: [],
};

const open = async (idb = new FakeIdb()) => ({ idb, store: await openRecordStore(idb as unknown as IDBFactory) });

describe('the device store is IndexedDB, and a commit is durable when it resolves (M8-15)', () => {
  it('commits in one read-write transaction over every store it writes, asking for strict durability by name', async () => {
    const { idb, store } = await open();
    await saveRecord(store, record);
    expect(idb.transactions).toEqual([{ stores: ['attempts', 'events', 'device'], mode: 'readwrite', options: { durability: 'strict' } }]);
  });

  it('reads back what it committed: the facts, the rows in the attempt, the active marker', async () => {
    const { store } = await open();
    await saveRecord(store, record);
    expect(await loadRecord(store, 'att-1')).toEqual(record);
    expect(await store.active()).toBe('att-1');
  });

  it('reads nothing for an attempt it holds nothing for, and no active attempt before one is committed', async () => {
    const { store } = await open();
    expect(await store.read('att-9')).toBeNull();
    expect(await store.active()).toBeNull();
  });

  it('keeps the rows of one attempt apart from another\'s', async () => {
    const { store } = await open();
    await saveRecord(store, record);
    await saveRecord(store, { ...record, attemptId: 'att-2', events: record.events.map((event) => ({ ...event, attemptId: 'att-2' })), acknowledgedIds: [] });
    expect((await loadRecord(store, 'att-1'))!.events.every((event) => event.attemptId === 'att-1')).toBe(true);
    expect(await store.active()).toBe('att-2');
  });

  it('adds a row to an attempt it holds and changes the state of one already there, without writing the others', async () => {
    const { store } = await open();
    await saveRecord(store, record);
    const next = { ...record, events: [...record.events, { eventId: 'e3', attemptId: 'att-1', slot: 'q1', sequence: 3, monotonicMs: 3, kind: 'select' as const, answer: 'c' }], acknowledgedIds: ['e1', 'e2'] };
    const { meta, rows } = splitRecord(next);
    await store.commit({ meta, rows: rows.filter((row) => row.eventId !== 'e1'), active: true });
    expect(await loadRecord(store, 'att-1')).toEqual(next);
  });

  it('does not touch the active marker for a commit that does not ask to', async () => {
    const { store } = await open();
    await saveRecord(store, record, false);
    expect(await store.active()).toBeNull();
    expect(await loadRecord(store, 'att-1')).toEqual(record);
  });

  it('applies none of a commit that fails: the log is as it was', async () => {
    const { idb, store } = await open();
    await saveRecord(store, record);
    idb.failNext = 'the disk is full';
    const next = { ...record, events: [...record.events, { eventId: 'e3', attemptId: 'att-1', slot: 'q1', sequence: 3, monotonicMs: 3, kind: 'visit' as const }] };
    await expect(saveRecord(store, next)).rejects.toThrow('the disk is full');
    expect(await loadRecord(store, 'att-1')).toEqual(record);
  });
});

describe('opening it', () => {
  it('creates the stores on first use, once, and leaves them as they are on the next', async () => {
    const idb = new FakeIdb();
    await open(idb);
    expect([...idb.stores.keys()].sort()).toEqual(['attempts', 'device', 'drafts', 'events']);
    const { store } = await open(idb);
    await saveRecord(store, record);
    await open(idb);
    expect(idb.version).toBe(2);
    expect(idb.stores.get('events')!.rows.size).toBe(2);
  });

  it('says why when the browser will not open it, or another tab holds it', async () => {
    const refused = new FakeIdb();
    refused.failOpen = 'SecurityError';
    await expect(openRecordStore(refused as unknown as IDBFactory)).rejects.toThrow('SecurityError');
    const blocked = new FakeIdb();
    blocked.blockOpen = true;
    await expect(openRecordStore(blocked as unknown as IDBFactory)).rejects.toThrow('blocked by another tab');
  });
});

describe('a browser that has none to give', () => {
  it('commits nothing and says why on every commit, and reads as empty', async () => {
    const store = unavailableRecordStore(new Error('no IndexedDB'));
    await expect(saveRecord(store, record)).rejects.toThrow('no IndexedDB');
    expect(await store.read('att-1')).toBeNull();
    expect(await store.active()).toBeNull();
  });

  it('has words for a reason that is not an error', async () => {
    await expect(saveRecord(unavailableRecordStore('nope'), record)).rejects.toThrow('this device could not open its store');
  });
});

describe('the onboarding draft is on the same disk (M8-22)', () => {
  const openDrafts = (idb: FakeIdb) => openDraftStore(idb as unknown as IDBFactory);

  it('keeps what was written, replaces it on the next write, and forgets it when cleared', async () => {
    const idb = new FakeIdb();
    const drafts = await openDrafts(idb);
    expect(await drafts.read()).toBeNull();
    await drafts.write({ examCode: 'JEE_MAIN', targetYear: '2027' });
    expect(await drafts.read()).toEqual({ examCode: 'JEE_MAIN', targetYear: '2027' });
    await drafts.write({ currentClass: 'class_12' });
    expect(await drafts.read()).toEqual({ currentClass: 'class_12' });
    await drafts.clear();
    expect(await drafts.read()).toBeNull();
  });

  it('is there when the page is opened again, because it was written to the disk', async () => {
    const idb = new FakeIdb();
    await (await openDrafts(idb)).write({ currentClass: 'repeater' });
    expect(await (await openDrafts(idb)).read()).toEqual({ currentClass: 'repeater' });
  });

  it('writes with strict durability, as the response log does, and reports a failed write rather than pretending', async () => {
    const idb = new FakeIdb();
    const drafts = await openDrafts(idb);
    await drafts.write({ currentClass: 'class_11' });
    expect(idb.transactions.at(-1)).toMatchObject({ stores: ['drafts'], mode: 'readwrite', options: { durability: 'strict' } });
    idb.failNext = 'QuotaExceededError';
    await expect(drafts.write({ currentClass: 'class_12' })).rejects.toThrow('QuotaExceededError');
    expect(await drafts.read()).toEqual({ currentClass: 'class_11' });
  });

  it('is added to a device that already has the response log, and leaves the log as it was', async () => {
    const idb = new FakeIdb();
    await open(idb).then(({ store }) => saveRecord(store, record));
    // the device as an earlier build left it: version 1, without the drafts store
    idb.version = 1;
    idb.stores.delete('drafts');
    const drafts = await openDrafts(idb);
    await drafts.write({ currentClass: 'class_12' });
    expect(idb.version).toBe(2);
    expect(idb.stores.get('events')!.rows.size).toBe(2);
    expect(await drafts.read()).toEqual({ currentClass: 'class_12' });
  });
});
