import { describe, expect, it } from 'vitest';
import { SystemClock } from './clock.js';

describe('SystemClock — monotonic across calls', () => {
  it('never returns a Date earlier than the previous call', () => {
    const clock = new SystemClock();
    let previous = clock.now();
    for (let i = 0; i < 50; i += 1) {
      const current = clock.now();
      expect(current.getTime()).toBeGreaterThanOrEqual(previous.getTime());
      previous = current;
    }
  });

  it('returns a real Date close to the wall clock', () => {
    const before = Date.now();
    const observed = new SystemClock().now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});
