import { describe, expect, it } from 'vitest';
import { GaveUpWaiting, withinTime } from './within-time.js';

/** A clock the test holds: `schedule` is what the host's `setTimeout` is, and `tick` is the time passing. */
function clock() {
  const waiting: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      waiting.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    tick: () => waiting.filter((entry) => !entry.cancelled).forEach((entry) => entry.fn()),
    waiting,
  };
}

describe('giving up on a request that is slow (M8-33)', () => {
  it('passes on the answer when it comes in time, and stops waiting', async () => {
    const time = clock();
    await expect(withinTime(Promise.resolve('Right'), 6_000, time.schedule)).resolves.toBe('Right');
    expect(time.waiting).toMatchObject([{ ms: 6_000, cancelled: true }]);
  });

  it('passes on the failure when the request fails, and stops waiting', async () => {
    const time = clock();
    await expect(withinTime(Promise.reject(new TypeError('Failed to fetch')), 6_000, time.schedule)).rejects.toThrow('Failed to fetch');
    expect(time.waiting[0]!.cancelled).toBe(true);
  });

  it('gives up when the time is up, saying the connection was the reason, and ignores the answer that comes afterwards', async () => {
    const time = clock();
    let late: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => (late = resolve));
    const waited = withinTime(slow, 6_000, time.schedule);
    time.tick();
    await expect(waited).rejects.toBeInstanceOf(GaveUpWaiting);
    late('Right');
    await expect(waited).rejects.toThrow('did not answer in time');
  });
});
