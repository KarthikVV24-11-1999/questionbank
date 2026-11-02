import { describe, expect, it } from 'vitest';
import { BoundedWork } from '../../../platform/concurrency/bounded-work.js';
import { systemTimers } from '../../../platform/scheduling/system-timers.js';
import { isSaturation } from '../application/saturation.js';
import type { PasswordHasher } from '../application/ports.js';
import { CURRENT_PASSWORD_PARAMETERS, type StoredCredential } from '../domain/password-hash.js';
import { BoundedPasswordHasher } from './bounded-password-hasher.js';

const stored: StoredCredential = { parameters: CURRENT_PASSWORD_PARAMETERS, salt: new Uint8Array(16), hash: new Uint8Array(32) };

function slowHasher() {
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  const enter = (): Promise<void> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<void>((resolve) => gates.push(() => { inFlight -= 1; resolve(); }));
  };
  const hasher: PasswordHasher = {
    parameters: CURRENT_PASSWORD_PARAMETERS,
    hash: async () => { await enter(); return stored; },
    verify: async () => { await enter(); return true; },
  };
  return { hasher, gates, peak: () => peak };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('a hasher whose derives take turns', () => {
  it('passes the parameters through, and the results', async () => {
    const { hasher, gates } = slowHasher();
    const bounded = new BoundedPasswordHasher(hasher, new BoundedWork({ concurrency: 1, queueLimit: 1, waitMs: 1000, timers: systemTimers }));
    expect(bounded.parameters).toBe(CURRENT_PASSWORD_PARAMETERS);
    const hashing = bounded.hash('a password');
    await tick();
    gates.shift()!();
    expect(await hashing).toBe(stored);
    const verifying = bounded.verify('a password', stored);
    await tick();
    gates.shift()!();
    expect(await verifying).toBe(true);
  });

  it('counts a hash and a verify against the same limit', async () => {
    const { hasher, gates, peak } = slowHasher();
    const bounded = new BoundedPasswordHasher(hasher, new BoundedWork({ concurrency: 2, queueLimit: 10, waitMs: 5000, timers: systemTimers }));
    const runs = [bounded.hash('a'), bounded.verify('b', stored), bounded.hash('c'), bounded.verify('d', stored), bounded.hash('e')];
    for (let done = 0; done < runs.length; done += 1) {
      await tick();
      gates.shift()!();
    }
    await Promise.all(runs);
    expect(peak()).toBe(2);
  });

  it('refuses with WorkSaturated, for a hash and for a verify, when there is no room', async () => {
    const { hasher, gates } = slowHasher();
    const bounded = new BoundedPasswordHasher(hasher, new BoundedWork({ concurrency: 1, queueLimit: 0, waitMs: 1000, timers: systemTimers }));
    const running = bounded.hash('a');
    await tick();
    await expect(bounded.hash('b')).rejects.toSatisfy(isSaturation);
    await expect(bounded.verify('c', stored)).rejects.toSatisfy(isSaturation);
    gates.shift()!();
    await running;
  });
});
