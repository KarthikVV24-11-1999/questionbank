import { describe, expect, it } from 'vitest';
import type { ResponseEvent } from './response-event.js';
import * as responseLog from './response-log.js';
import { append, emptyLog, logFromEvents, recordLate, type ResponseLog } from './response-log.js';

const select = (eventId: string, sequence: number, answer: string = 'A', attemptId = 'a1'): ResponseEvent => ({
  eventId,
  attemptId,
  slot: 'q1',
  sequence,
  monotonicMs: sequence * 10,
  kind: 'select',
  answer,
});

function appended(log: ResponseLog, event: ResponseEvent): ResponseLog {
  const result = append(log, event);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.log;
}

describe('append', () => {
  it('returns a new log and mutates nothing', () => {
    const before = emptyLog('a1');
    const frozenEvents = before.events;
    const after = appended(before, select('e1', 1));
    expect(after).not.toBe(before);
    expect(after.events.map((e) => e.eventId)).toEqual(['e1']);
    expect(before.events).toBe(frozenEvents);
    expect(before.events).toEqual([]);
  });

  it('keeps events in the order they were appended', () => {
    const log = [select('b', 1), select('a', 2), select('c', 5)].reduce(appended, emptyLog('a1'));
    expect(log.events.map((e) => e.eventId)).toEqual(['b', 'a', 'c']);
  });

  it('silently ignores a duplicate event_id: the same log comes back', () => {
    const once = appended(emptyLog('a1'), select('e1', 1));
    const result = append(once, select('e1', 1));
    expect(result).toEqual({ ok: true, log: once });
    expect(result.ok && result.log).toBe(once);
  });

  it('ignores a replay even though its sequence is now behind the log', () => {
    const log = [select('e1', 1), select('e2', 2), select('e3', 3)].reduce(appended, emptyLog('a1'));
    const result = append(log, select('e1', 1));
    expect(result.ok && result.log.events).toHaveLength(3);
  });

  it('refuses a different event reusing a known id', () => {
    const once = appended(emptyLog('a1'), select('e1', 1, 'A'));
    expect(append(once, select('e1', 1, 'B'))).toEqual({ ok: false, reason: 'conflicting_event', eventId: 'e1' });
  });

  it('refuses a sequence that does not rise, and says what the last one was', () => {
    const log = appended(emptyLog('a1'), select('e1', 5));
    expect(append(log, select('e2', 4))).toEqual({
      ok: false,
      reason: 'sequence_regression',
      eventId: 'e2',
      lastSequence: 5,
    });
    expect(append(log, select('e3', 5)).ok).toBe(false);
  });

  it('accepts a sequence gap, since a merge from another device leaves them', () => {
    const log = appended(emptyLog('a1'), select('e1', 1));
    expect(append(log, select('e2', 40)).ok).toBe(true);
  });

  it('refuses an event for another attempt', () => {
    expect(append(emptyLog('a1'), select('e1', 1, 'A', 'other'))).toEqual({
      ok: false,
      reason: 'wrong_attempt',
      eventId: 'e1',
    });
  });

  it('exposes no way to change what is already in the log', () => {
    expect(Object.keys(responseLog).sort()).toEqual(['append', 'emptyLog', 'logFromEvents', 'recordLate']);
  });
});

describe('recordLate', () => {
  it('keeps an event whose sequence is behind the log, which append would refuse', () => {
    const log = appended(emptyLog('a1'), select('e9', 9));
    expect(append(log, select('e2', 2)).ok).toBe(false);
    const late = recordLate(log, select('e2', 2));
    expect(late.ok && late.log.events.map((e) => e.eventId)).toEqual(['e9', 'e2']);
  });

  it('still de-duplicates, refuses conflicts and refuses another attempt', () => {
    const log = appended(emptyLog('a1'), select('e1', 1, 'A'));
    const same = recordLate(log, select('e1', 1, 'A'));
    expect(same.ok && same.log).toBe(log);
    expect(recordLate(log, select('e1', 1, 'B'))).toEqual({ ok: false, reason: 'conflicting_event', eventId: 'e1' });
    expect(recordLate(log, select('e2', 2, 'A', 'other'))).toEqual({
      ok: false,
      reason: 'wrong_attempt',
      eventId: 'e2',
    });
  });
});

describe('logFromEvents', () => {
  it('de-duplicates and sorts into canonical order whatever order it was given', () => {
    const result = logFromEvents('a1', [select('b', 2), select('a', 1), select('b', 2), select('c', 2)]);
    expect(result.ok && result.log.events.map((e) => e.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a conflicting duplicate and a foreign attempt', () => {
    expect(logFromEvents('a1', [select('a', 1, 'A'), select('a', 1, 'B')])).toEqual({
      ok: false,
      reason: 'conflicting_event',
      eventId: 'a',
    });
    expect(logFromEvents('a1', [select('a', 1, 'A', 'other')])).toEqual({
      ok: false,
      reason: 'wrong_attempt',
      eventId: 'a',
    });
  });
});
