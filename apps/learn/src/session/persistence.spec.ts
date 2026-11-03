import { describe, expect, it } from 'vitest';
import { MemoryRecords, MemoryStorage } from '../testing/fakes.js';
import { assembleRecord, loadRecord, mergeRecords, migrateLegacy, saveRecord, splitRecord, type LegacyStorage, type SessionRecord } from './persistence.js';

const record: SessionRecord = {
  version: 1,
  attemptId: 'att-1',
  deviceRef: 'dev',
  intervalCapMs: 90_000,
  deadline: '2026-10-21T11:30:00.000Z',
  formId: 'form-1',
  serverOffsetMs: -300_000,
  submissionReason: null,
  events: [
    { eventId: 'e1', attemptId: 'att-1', slot: 'q1', sequence: 1, monotonicMs: 10, kind: 'visit' },
    { eventId: 'e2', attemptId: 'att-1', slot: 'q1', sequence: 2, monotonicMs: 20, kind: 'select', answer: 'b' },
    { eventId: 'e3', attemptId: 'att-1', slot: 'q1', sequence: 3, monotonicMs: 30, kind: 'select', answer: 'c' },
  ],
  acknowledgedIds: ['e1'],
  rejectedIds: ['e3'],
};

describe('a record is stored as its facts and a row per event, and put back together whole', () => {
  it('splits into the facts without the events and one row each carrying whether the server has it, refused it, or has not been told', () => {
    const { meta, rows } = splitRecord(record);
    expect(Object.keys(meta).sort()).toEqual(['attemptId', 'deadline', 'deviceRef', 'formId', 'intervalCapMs', 'serverOffsetMs', 'submissionReason', 'version']);
    expect(rows.map((row) => [row.eventId, row.sequence, row.state])).toEqual([['e1', 1, 'acknowledged'], ['e2', 2, 'open'], ['e3', 3, 'rejected']]);
  });

  it('saves and loads the same record, with the events in the order of their sequence whatever order the rows come back in', async () => {
    const store = new MemoryRecords();
    await saveRecord(store, record);
    expect(await loadRecord(store, 'att-1')).toEqual(record);
    expect(store.activeId).toBe('att-1');
    const stored = (await store.read('att-1'))!;
    expect(assembleRecord('att-1', { meta: stored.meta, rows: [...stored.rows].reverse() })).toEqual(record);
  });

  it('can save a record without making it the active one', async () => {
    const store = new MemoryRecords();
    await saveRecord(store, record, false);
    expect(store.activeId).toBeNull();
    expect(await loadRecord(store, 'att-1')).toEqual(record);
  });

  it('finds nothing for an attempt it holds nothing for', async () => {
    expect(await loadRecord(new MemoryRecords(), 'att-1')).toBeNull();
    expect(assembleRecord('att-1', null)).toBeNull();
  });

  it('reads a record that does not parse as absent: a version it does not know, an event of a kind it does not, a fact it was not told of, a row that is not a row', async () => {
    const good = { meta: splitRecord(record).meta, rows: splitRecord(record).rows };
    expect(assembleRecord('att-1', good)).toEqual(record);
    expect(assembleRecord('att-1', { ...good, meta: { ...good.meta, version: 2 } })).toBeNull();
    expect(assembleRecord('att-1', { ...good, meta: { ...good.meta, surprise: true } })).toBeNull();
    expect(assembleRecord('att-1', { ...good, meta: 'not an object' })).toBeNull();
    expect(assembleRecord('att-1', { ...good, meta: null })).toBeNull();
    expect(assembleRecord('att-1', { ...good, rows: [{ ...good.rows[0], event: { ...good.rows[0]!.event, kind: 'ponder' } }] })).toBeNull();
    expect(assembleRecord('att-1', { ...good, rows: [{ ...good.rows[0], state: 'maybe' }] })).toBeNull();
    expect(assembleRecord('att-1', { ...good, rows: ['half a row'] })).toBeNull();
    expect(assembleRecord('att-1', { ...good, rows: 'not rows' as never })).toBeNull();
  });

  it('will not hand a record of one attempt over as another\'s, by its facts or by a row', () => {
    const good = { meta: splitRecord(record).meta, rows: splitRecord(record).rows };
    expect(assembleRecord('att-2', good)).toBeNull();
    expect(assembleRecord('att-2', { meta: good.meta, rows: [] })).toBeNull(); // facts of one attempt and no rows at all
    expect(assembleRecord('att-1', { ...good, rows: [...good.rows, { ...good.rows[0]!, attemptId: 'att-2' }] })).toBeNull();
  });

  it('gives a record written before the form and the offset were kept their defaults', () => {
    const { formId: _form, serverOffsetMs: _offset, ...older } = splitRecord(record).meta;
    expect(assembleRecord('att-1', { meta: older, rows: splitRecord(record).rows })).toMatchObject({ formId: null, serverOffsetMs: null });
  });
});

describe('events with one sequence number', () => {
  const twin = (eventId: string) => ({ eventId, attemptId: 'att-1', slot: 'q1', sequence: 5, monotonicMs: 5, kind: 'visit' as const });

  it('are put in a fixed order by id, so two readings of one disk agree', () => {
    const rows = (ids: string[]) => ids.map((eventId) => ({ attemptId: 'att-1', eventId, sequence: 5, state: 'open' as const, event: twin(eventId) }));
    const meta = splitRecord(record).meta;
    for (const order of [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'c', 'a']]) {
      expect(assembleRecord('att-1', { meta, rows: rows(order) })!.events.map((event) => event.eventId)).toEqual(['a', 'b', 'c']);
    }
  });

  it('are merged in the same fixed order', () => {
    const alone = (...ids: string[]): SessionRecord => ({ ...record, events: ids.map(twin), acknowledgedIds: [], rejectedIds: [] });
    expect(mergeRecords(alone('b', 'c'), alone('a')).events.map((event) => event.eventId)).toEqual(['a', 'b', 'c']);
    expect(mergeRecords(alone('a'), alone('c', 'b')).events.map((event) => event.eventId)).toEqual(['a', 'b', 'c']);
  });
});

describe('two records of one attempt become one, and no event is lost to it', () => {
  const later: SessionRecord = { ...record, events: [...record.events, { eventId: 'e4', attemptId: 'att-1', slot: 'q2', sequence: 4, monotonicMs: 40, kind: 'visit' }], acknowledgedIds: [], rejectedIds: [], formId: null, serverOffsetMs: null };

  it('holds the events of both, once each, in the order of their sequence', () => {
    const merged = mergeRecords({ ...record, events: [record.events[2]!, record.events[0]!] }, later);
    expect(merged.events.map((event) => event.eventId)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('holds what the server has or refused according to either', () => {
    const merged = mergeRecords({ ...record, acknowledgedIds: ['e1'], rejectedIds: [] }, { ...later, acknowledgedIds: ['e2'], rejectedIds: ['e3'] });
    expect(merged.acknowledgedIds.sort()).toEqual(['e1', 'e2']);
    expect(merged.rejectedIds).toEqual(['e3']);
  });

  it('takes its facts from the one that holds more events, and fills a gap from the other', () => {
    expect(mergeRecords(record, later).deviceRef).toBe('dev');
    const richerSecond = mergeRecords({ ...record, deviceRef: 'old' }, { ...later, deviceRef: 'new' });
    expect(richerSecond.deviceRef).toBe('new');
    expect(richerSecond.formId).toBe('form-1');
    expect(richerSecond.serverOffsetMs).toBe(-300_000);
    expect(mergeRecords({ ...record, formId: null, serverOffsetMs: null }, { ...later, formId: 'f2', serverOffsetMs: 5 })).toMatchObject({ formId: 'f2', serverOffsetMs: 5 });
  });

  it('fills each fact from whichever of the two holds it, the richer first', () => {
    const bare = { ...record, formId: null, serverOffsetMs: null };
    const richerBare = { ...bare, events: [...record.events, { eventId: 'e9', attemptId: 'att-1', slot: 'q1', sequence: 9, monotonicMs: 9, kind: 'visit' as const }] };
    // the richer holds neither, the other one does
    expect(mergeRecords(record, richerBare)).toMatchObject({ formId: 'form-1', serverOffsetMs: -300_000 });
    // neither holds either
    expect(mergeRecords(bare, richerBare)).toMatchObject({ formId: null, serverOffsetMs: null });
    // only the second, richer-less one does
    expect(mergeRecords({ ...bare, events: record.events }, { ...record, events: record.events.slice(0, 1) })).toMatchObject({ formId: 'form-1', serverOffsetMs: -300_000 });
  });

  it('takes the facts from the first when both hold as many events', () => {
    const same = { ...record, deviceRef: 'the-other' };
    expect(mergeRecords(record, same).deviceRef).toBe('dev');
    expect(mergeRecords(same, record).deviceRef).toBe('the-other');
  });

  it('keeps the first one\'s submission when both took one', () => {
    expect(mergeRecords({ ...record, submissionReason: 'manual' }, { ...later, submissionReason: 'expiry' }).submissionReason).toBe('manual');
  });

  it('keeps a submission either of them took', () => {
    expect(mergeRecords({ ...record, submissionReason: 'manual' }, later).submissionReason).toBe('manual');
    expect(mergeRecords(record, { ...later, submissionReason: 'expiry' }).submissionReason).toBe('expiry');
  });
});

/** `localStorage` as an earlier build kept the record in it. */
function legacy(entries: Record<string, string> = {}): MemoryStorage & LegacyStorage {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
  return Object.assign(storage, { keys: () => [...storage.data.keys()] });
}
const asLegacy = (value: SessionRecord): string => JSON.stringify(value);

describe('what an earlier build left in localStorage is moved to the device\'s store, and not lost on the way (M8-15)', () => {
  it('copies the attempt, makes it the active one, and removes the old keys only once it is committed', async () => {
    const old = legacy({ 'qb.attempt.att-1': asLegacy(record), 'qb.attempt.active': 'att-1', 'qb.analytics.actor': 'dev-x' });
    const store = new MemoryRecords();
    const removedBeforeCommit: boolean[] = [];
    const commit = store.commit.bind(store);
    store.commit = async (change) => {
      await commit(change);
      removedBeforeCommit.push(old.getItem('qb.attempt.att-1') === null);
    };
    expect(await migrateLegacy(old, store)).toBe(1);
    // the old copy was still there when the commit of the record resolved; the second commit is the marker, after the copy was already gone
    expect(removedBeforeCommit).toEqual([false, true]);
    expect(await loadRecord(store, 'att-1')).toEqual(record);
    expect(await store.active()).toBe('att-1');
    expect([...old.data.keys()]).toEqual(['qb.analytics.actor']); // everything else in localStorage is none of its business
  });

  it('leaves the old copy where it is when the commit fails, so the next run can try again', async () => {
    const old = legacy({ 'qb.attempt.att-1': asLegacy(record), 'qb.attempt.active': 'att-1' });
    const store = new MemoryRecords();
    store.failWith = new Error('quota');
    await expect(migrateLegacy(old, store)).rejects.toThrow('quota');
    expect(old.getItem('qb.attempt.att-1')).not.toBeNull();
    expect(old.getItem('qb.attempt.active')).toBe('att-1');
  });

  it('moves every attempt it finds, but only the one that was active becomes the active one', async () => {
    const other = { ...record, attemptId: 'att-0', events: record.events.map((event) => ({ ...event, attemptId: 'att-0' })) };
    const old = legacy({ 'qb.attempt.att-0': asLegacy(other), 'qb.attempt.att-1': asLegacy(record), 'qb.attempt.active': 'att-1' });
    const store = new MemoryRecords();
    expect(await migrateLegacy(old, store)).toBe(2);
    expect(await store.active()).toBe('att-1');
    expect(await loadRecord(store, 'att-0')).toEqual(other);
  });

  it('merges with a record the store already holds for the attempt, losing the event of neither, and removes the old', async () => {
    const store = new MemoryRecords();
    const newer = { eventId: 'e9', attemptId: 'att-1', slot: 'q2', sequence: 9, monotonicMs: 90, kind: 'visit' as const };
    await saveRecord(store, { ...record, events: [record.events[0]!, newer], acknowledgedIds: ['e1', 'e9'], rejectedIds: [] });
    // the old record never heard that the server has e1
    const old = legacy({ 'qb.attempt.att-1': asLegacy({ ...record, acknowledgedIds: [], rejectedIds: [] }), 'qb.attempt.active': 'att-1' });
    await migrateLegacy(old, store);
    // the store held an event the old record did not, and the old held two the store did not: all of them are kept
    const merged = (await loadRecord(store, 'att-1'))!;
    expect(merged.events.map((event) => event.eventId)).toEqual(['e1', 'e2', 'e3', 'e9']);
    // and what the store knew of the server is not forgotten because the old record did not
    expect(merged.acknowledgedIds.sort()).toEqual(['e1', 'e9']);
    expect(old.getItem('qb.attempt.att-1')).toBeNull();
  });

  it('is done after one run: the next finds nothing to move and changes nothing', async () => {
    const old = legacy({ 'qb.attempt.att-1': asLegacy(record), 'qb.attempt.active': 'att-1' });
    const store = new MemoryRecords();
    await migrateLegacy(old, store);
    const commits = store.commits.length;
    expect(await migrateLegacy(old, store)).toBe(0);
    expect(store.commits).toHaveLength(commits);
    expect(old.data.size).toBe(0);
  });

  it('does not touch a record that does not parse, nor one stored under another attempt\'s key', async () => {
    const old = legacy({ 'qb.attempt.att-1': '{half a record', 'qb.attempt.att-9': asLegacy(record), 'qb.attempt.att-2': JSON.stringify({ ...record, version: 2 }) });
    const store = new MemoryRecords();
    expect(await migrateLegacy(old, store)).toBe(0);
    expect(store.commits).toEqual([]);
    expect([...old.data.keys()].sort()).toEqual(['qb.attempt.att-1', 'qb.attempt.att-2', 'qb.attempt.att-9']);
  });

  it('keeps the store\'s own active attempt when it already names one, and still removes the old marker', async () => {
    const store = new MemoryRecords();
    await saveRecord(store, { ...record, attemptId: 'att-5', events: [], acknowledgedIds: [], rejectedIds: [] });
    const old = legacy({ 'qb.attempt.att-1': asLegacy(record), 'qb.attempt.active': 'att-1' });
    await migrateLegacy(old, store);
    expect(await store.active()).toBe('att-5');
    expect(old.getItem('qb.attempt.active')).toBeNull();
  });

  it('leaves the active marker when what it names could not be moved', async () => {
    const old = legacy({ 'qb.attempt.active': 'att-1', 'qb.attempt.att-1': '{half a record' });
    const store = new MemoryRecords();
    await migrateLegacy(old, store);
    expect(old.getItem('qb.attempt.active')).toBe('att-1');
  });

  it('skips a key it was told of that has gone by the time it reads it', async () => {
    const ghost = Object.assign(new MemoryStorage(), { keys: () => ['qb.attempt.ghost'] });
    const store = new MemoryRecords();
    expect(await migrateLegacy(ghost, store)).toBe(0);
    expect(store.commits).toEqual([]);
  });

  it('does nothing in a browser that never held a record', async () => {
    const store = new MemoryRecords();
    expect(await migrateLegacy(legacy(), store)).toBe(0);
    expect(store.commits).toEqual([]);
  });
});
