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

  it('calls the function once after the wait, and not again', () => {
    vi.useFakeTimers();
    let calls = 0;
    systemTimers.after(1_000, () => void (calls += 1));
    vi.advanceTimersByTime(999);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
  });

  it('does not call it at all if it is cancelled first, and leaves no timer behind', () => {
    vi.useFakeTimers();
    let calls = 0;
    const cancel = systemTimers.after(1_000, () => void (calls += 1));
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(calls).toBe(0);
  });

  it('does not keep the process alive while it waits: the timer it starts is not referenced', () => {
    const started = vi.spyOn(globalThis, 'setTimeout');
    const cancel = systemTimers.after(60_000, () => undefined);
    const handle = started.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    cancel();
    started.mockRestore();
  });
});
