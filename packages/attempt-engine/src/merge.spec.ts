import { describe, expect, it } from 'vitest';
import { mergeLogs } from './merge.js';
import type { ResponseEvent } from './response-event.js';
import { logFromEvents, type ResponseLog } from './response-log.js';
import { randomEvents, seeded, shuffled } from './testing/generators.js';

function logOf(events: readonly ResponseEvent[], attemptId = 'a1'): ResponseLog {
  const result = logFromEvents(attemptId, events);
  if (!result.ok) throw new Error(result.reason);
  return result.log;
}

function merged(a: ResponseLog, b: ResponseLog): ResponseLog {
  const result = mergeLogs(a, b);
  if (!result.ok) throw new Error(result.reason);
  return result.log;
}

const ids = (log: ResponseLog) => log.events.map((e) => e.eventId).sort();

/**
 * Two devices that share a prefix of history (what had synced before the
 * switch) and then each captured events the other never saw.
 */
function twoDevices(seed: number) {
  const random = seeded(seed);
  const shared = randomEvents(random, { idPrefix: 'shared-', count: 8 });
  const onPhone = randomEvents(random, { idPrefix: 'phone-', count: 12, firstSequence: 20 });
  const onLaptop = randomEvents(random, { idPrefix: 'laptop-', count: 12, firstSequence: 20 });
  return {
    phone: logOf(shuffled([...shared, ...onPhone], random)),
    laptop: logOf(shuffled([...shared, ...onLaptop], random)),
    everything: [...shared, ...onPhone, ...onLaptop],
  };
}

/** Planted violation: whichever log ends later wins outright, and the other side's events are dropped. */
function lastWriterWins(a: ResponseLog, b: ResponseLog): ResponseLog {
  const endOf = (log: ResponseLog) => log.events.at(-1)?.sequence ?? -1;
  return endOf(a) >= endOf(b) ? a : b;
}

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);

describe('mergeLogs is a set union by event_id', () => {
  it('keeps every event from both devices, exactly once', () => {
    for (const seed of SEEDS) {
      const { phone, laptop, everything } = twoDevices(seed);
      expect(ids(merged(phone, laptop))).toEqual(everything.map((e) => e.eventId).sort());
    }
  });

  it('is commutative: merge(a, b) equals merge(b, a)', () => {
    for (const seed of SEEDS) {
      const { phone, laptop } = twoDevices(seed);
      expect(merged(phone, laptop)).toEqual(merged(laptop, phone));
    }
  });

  it('is idempotent: merge(a, a) equals a', () => {
    for (const seed of SEEDS) {
      const { phone } = twoDevices(seed);
      expect(merged(phone, phone)).toEqual(phone);
    }
  });

  it('is associative, so three devices merge the same in any grouping', () => {
    for (const seed of SEEDS) {
      const random = seeded(seed);
      const [a, b, c] = ['x-', 'y-', 'z-'].map((idPrefix) => logOf(randomEvents(random, { idPrefix, count: 10, firstSequence: 3 }))) as [
        ResponseLog,
        ResponseLog,
        ResponseLog,
      ];
      expect(merged(merged(a, b), c)).toEqual(merged(a, merged(b, c)));
    }
  });

  it('merging a log with an older copy of itself changes nothing', () => {
    const { phone } = twoDevices(5);
    const older = logOf(phone.events.slice(0, 5));
    expect(merged(phone, older)).toEqual(phone);
  });

  it('merging with an empty log returns the other log', () => {
    const { phone } = twoDevices(3);
    expect(merged(phone, logOf([]))).toEqual(phone);
    expect(merged(logOf([]), phone)).toEqual(phone);
  });

  it('is not vacuous: the devices really do hold events the other lacks', () => {
    const { phone, laptop } = twoDevices(1);
    expect(ids(phone).some((id) => !ids(laptop).includes(id))).toBe(true);
    expect(ids(laptop).some((id) => !ids(phone).includes(id))).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses logs of different attempts', () => {
    expect(mergeLogs(logOf([], 'a1'), logOf([], 'a2'))).toEqual({ ok: false, reason: 'attempt_mismatch' });
  });

  it('refuses an event id that names different content on the two sides', () => {
    const base = randomEvents(seeded(1), { count: 1 })[0] as ResponseEvent;
    const forged = { ...base, slot: 'elsewhere' };
    expect(mergeLogs(logOf([base]), logOf([forged]))).toEqual({
      ok: false,
      reason: 'conflicting_event',
      eventId: base.eventId,
    });
  });
});

describe('last-writer-wins is the wrong merge, and the test says which event it loses', () => {
  it('a planted last-writer-wins merge drops an event, and the union check names it', () => {
    const { phone, laptop } = twoDevices(1);
    const result = lastWriterWins(phone, laptop);
    const survivors = new Set(ids(result));
    const lost = [...ids(phone), ...ids(laptop)].filter((id) => !survivors.has(id));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost[0]).toMatch(/^(phone|laptop|shared)-/u);
    // and the real merge, on the very same inputs, loses none
    const real = new Set(ids(merged(phone, laptop)));
    expect(lost.filter((id) => !real.has(id))).toEqual([]);
  });
});
