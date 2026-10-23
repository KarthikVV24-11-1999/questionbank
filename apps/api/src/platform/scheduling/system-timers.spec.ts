import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemTimers } from './system-timers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('the real timers', () => {
  it('calls the function at each interval until stopped', () => {
    vi.useFakeTimers();
    let calls = 0;
    const stop = systemTimers.every(1_000, () => void (calls += 1));
    vi.advanceTimersByTime(3_000);
    expect(calls).toBe(3);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(calls).toBe(3);
  });

  it('does not keep the process alive on its own', () => {
    vi.useFakeTimers();
    const stop = systemTimers.every(1_000, () => undefined);
    // a referenced timer would be counted here; an unreferenced one is not
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
