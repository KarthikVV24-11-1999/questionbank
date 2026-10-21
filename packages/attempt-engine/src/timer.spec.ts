import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  allowedFromDeadline,
  governingRemainingMs,
  isExpired,
  remainingMs,
  resume,
  startTimer,
} from './timer.js';

const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('allowed duration', () => {
  it('is the signed deadline minus the server time it was issued at', () => {
    expect(allowedFromDeadline({ issuedAtMs: 1_000_000, deadlineMs: 1_000_000 + 3 * HOUR })).toBe(3 * HOUR);
  });

  it('is never negative', () => {
    expect(allowedFromDeadline({ issuedAtMs: 5000, deadlineMs: 1000 })).toBe(0);
  });
});

describe('remaining time', () => {
  it('counts down with the monotonic reading', () => {
    const timer = startTimer(3 * HOUR, 500);
    expect(remainingMs(timer, 500)).toBe(3 * HOUR);
    expect(remainingMs(timer, 500 + HOUR)).toBe(2 * HOUR);
    expect(remainingMs(timer, 500 + 3 * HOUR)).toBe(0);
  });

  it('floors at zero and reports expiry from the reading alone', () => {
    const timer = startTimer(1000, 0);
    expect(isExpired(timer, 999)).toBe(false);
    expect(isExpired(timer, 1000)).toBe(true);
    expect(isExpired(timer, 9_000_000)).toBe(true);
    expect(remainingMs(timer, 9_000_000)).toBe(0);
  });

  it('agrees whether read directly or after folding time in with advance', () => {
    let timer = startTimer(10_000, 100);
    timer = advance(timer, 3100);
    expect(timer.consumedMs).toBe(3000);
    expect(remainingMs(timer, 3100)).toBe(7000);
    expect(remainingMs(timer, 5100)).toBe(5000);
    expect(remainingMs(advance(timer, 5100), 5100)).toBe(5000);
  });

  it('does not mutate the timer it was given', () => {
    const timer = startTimer(10_000, 0);
    advance(timer, 4000);
    expect(timer).toEqual({ allowedMs: 10_000, consumedMs: 0, lastReadingMs: 0 });
  });
});

describe('the wall clock does not matter', () => {
  const sequence = (timer = startTimer(3 * HOUR, 0)) => {
    const readings = [0, HOUR, 90 * 60_000, 2 * HOUR];
    let t = timer;
    return readings.map((reading) => {
      t = advance(t, reading);
      return [remainingMs(t, reading), isExpired(t, reading)];
    });
  };

  it('a wall-clock jump forward changes nothing', () => {
    const baseline = sequence();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const jumpedForward = sequence();
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    const jumpedBack = sequence();
    expect(jumpedForward).toEqual(baseline);
    expect(jumpedBack).toEqual(baseline);
    expect(baseline[3]).toEqual([HOUR, false]);
  });

  it('never reads the clock at all: Date.now is not called', () => {
    const spy = vi.spyOn(Date, 'now');
    sequence();
    resume(startTimer(1, 0), 5);
    governingRemainingMs(1, 2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('expiry is computed, not scheduled: no timer is ever created, and idle time passes nothing', () => {
    vi.useFakeTimers();
    const timer = startTimer(1000, 0);
    expect(isExpired(timer, 10)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * HOUR);
    expect(isExpired(timer, 10)).toBe(false);
    expect(remainingMs(timer, 10)).toBe(990);
  });
});

describe('a reading that goes backwards (the process restarted)', () => {
  it('counts nothing for the gap and re-baselines', () => {
    let timer = startTimer(10_000, 50_000);
    timer = advance(timer, 54_000);
    timer = advance(timer, 100);
    expect(timer).toEqual({ allowedMs: 10_000, consumedMs: 4000, lastReadingMs: 100 });
    expect(remainingMs(timer, 2100)).toBe(4000);
  });

  it('never yields more time than the attempt was allowed', () => {
    const timer = startTimer(10_000, 50_000);
    expect(remainingMs(timer, 0)).toBe(10_000);
  });
});

describe('resume', () => {
  it('re-baselines without counting the time the app was not running', () => {
    const timer = advance(startTimer(10_000, 0), 2000);
    const resumed = resume(timer, 900_000);
    expect(resumed.consumedMs).toBe(2000);
    expect(remainingMs(resumed, 901_000)).toBe(7000);
  });
});

describe('the stricter of client and server governs', () => {
  it('takes the smaller remaining time whichever side it is on', () => {
    expect(governingRemainingMs(5000, 3000)).toBe(3000);
    expect(governingRemainingMs(3000, 5000)).toBe(3000);
    expect(governingRemainingMs(0, 5000)).toBe(0);
  });
});
