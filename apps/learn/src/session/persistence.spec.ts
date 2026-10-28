import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../testing/fakes.js';
import { activeAttemptId, clearRecord, loadRecord, saveRecord, type SessionRecord } from './persistence.js';

const record: SessionRecord = {
  version: 1,
  attemptId: 'att-1',
  deviceRef: 'd',
  intervalCapMs: 90_000,
  deadline: '2026-10-21T11:30:00.000Z',
  formId: 'form-1',
  serverOffsetMs: 250,
  submissionReason: null,
  events: [{ eventId: 'e1', attemptId: 'att-1', slot: 'q1', sequence: 1, monotonicMs: 5, kind: 'select', answer: ['a', 'b'] }],
  acknowledgedIds: ['e1'],
  rejectedIds: [],
};

describe('what survives a reload (M6-50)', () => {
  it('reads back exactly what it wrote, and remembers which attempt this device was sitting', () => {
    const storage = new MemoryStorage();
    expect(activeAttemptId(storage)).toBeNull();
    saveRecord(storage, record);
    expect(loadRecord(storage, 'att-1')).toEqual(record);
    expect(activeAttemptId(storage)).toBe('att-1');
  });

  it('finds nothing for an attempt it never wrote', () => {
    expect(loadRecord(new MemoryStorage(), 'att-1')).toBeNull();
  });

  it('treats a record that is not readable as absent, never as partly trusted', () => {
    const storage = new MemoryStorage();
    storage.setItem('qb.attempt.att-1', '{half a record');
    expect(loadRecord(storage, 'att-1')).toBeNull();
    storage.setItem('qb.attempt.att-1', JSON.stringify({ ...record, version: 2 }));
    expect(loadRecord(storage, 'att-1')).toBeNull();
    storage.setItem('qb.attempt.att-1', JSON.stringify({ ...record, events: [{ ...record.events[0], kind: 'ponder' }] }));
    expect(loadRecord(storage, 'att-1')).toBeNull();
    storage.setItem('qb.attempt.att-1', JSON.stringify({ ...record, surprise: true }));
    expect(loadRecord(storage, 'att-1')).toBeNull();
  });

  it('refuses a record that names another attempt than the one asked for', () => {
    const storage = new MemoryStorage();
    storage.setItem('qb.attempt.att-2', JSON.stringify(record));
    expect(loadRecord(storage, 'att-2')).toBeNull();
  });

  it('forgets an attempt, and the pointer to it only if it pointed there', () => {
    const storage = new MemoryStorage();
    saveRecord(storage, record);
    saveRecord(storage, { ...record, attemptId: 'att-2', events: [] });
    clearRecord(storage, 'att-1');
    expect(loadRecord(storage, 'att-1')).toBeNull();
    expect(activeAttemptId(storage)).toBe('att-2');
    clearRecord(storage, 'att-2');
    expect(activeAttemptId(storage)).toBeNull();
  });

  it('reads a record written before the form and the clock offset were kept, as having neither', () => {
    const storage = new MemoryStorage();
    const { formId: _formId, serverOffsetMs: _serverOffsetMs, ...older } = record;
    storage.setItem('qb.attempt.att-1', JSON.stringify(older));
    expect(loadRecord(storage, 'att-1')).toMatchObject({ attemptId: 'att-1', formId: null, serverOffsetMs: null });
  });
});
