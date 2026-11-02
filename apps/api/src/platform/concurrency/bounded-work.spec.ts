import { describe, expect, it } from 'vitest';
import type { DelayPort } from '../scheduling/scheduler.js';
import { BoundedWork, WorkSaturated } from './bounded-work.js';

/** Time the test moves itself: a wait that is meant to end is ended by `advance`, not by sleeping. */
function fakeTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const timers: DelayPort = {
    after(ms, fn) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return () => void pending.delete(id);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/** Work that does not finish until the test says so. */
function held() {
  let release!: (value: string) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('work that may only run so many at a time', () => {
  it('starts work at once while there is a slot, and holds the rest in order', async () => {
    const bound = new BoundedWork({ concurrency: 2, queueLimit: 10, waitMs: 5_000, timers: fakeTimers().timers });
    const order: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((name) => ({ name, gate: held() }));
    const runs = jobs.map((job) =>
      bound.run(() => {
        order.push(job.name);
        return job.gate.promise;
      }),
    );
    await tick();
    expect(order).toEqual(['a', 'b']);
    expect([bound.inFlight, bound.queued]).toEqual([2, 2]);
    jobs[0]!.gate.release('a');
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    jobs[1]!.gate.release('b');
    await tick();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    jobs[2]!.gate.release('c');
    jobs[3]!.gate.release('d');
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c', 'd']);
    expect([bound.inFlight, bound.queued]).toEqual([0, 0]);
  });

  it('never has more than the limit in flight, however many are asked for', async () => {
    const bound = new BoundedWork({ concurrency: 3, queueLimit: 100, waitMs: 5_000, timers: fakeTimers().timers });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        bound.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick(1);
          inFlight -= 1;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it('refuses at once, as queue_full, when the queue is full, and leaves those already queued alone', async () => {
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 1, waitMs: 5_000, timers: fakeTimers().timers });
    const first = held();
    const running = bound.run(() => first.promise);
    const second = held();
    const waiting = bound.run(() => second.promise);
    await expect(bound.run(() => Promise.resolve('never'))).rejects.toMatchObject({ name: 'WorkSaturated', reason: 'queue_full' });
    first.release('1');
    second.release('2');
    expect(await Promise.all([running, waiting])).toEqual(['1', '2']);
  });

  it('refuses a caller that has waited its time, as wait_timeout, and takes it out of the queue', async () => {
    const clock = fakeTimers();
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 5, waitMs: 20, timers: clock.timers });
    const first = held();
    const running = bound.run(() => first.promise);
    const waiter = bound.run(() => Promise.resolve('late'));
    const outcome = waiter.then(() => 'served', (error: unknown) => error);
    clock.advance(19);
    await tick();
    expect(bound.queued).toBe(1);
    clock.advance(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(WorkSaturated);
    expect(error).toMatchObject({ reason: 'wait_timeout', saturated: true });
    expect(bound.queued).toBe(0);
    first.release('done');
    await running;
    expect(await bound.run(() => Promise.resolve('after'))).toBe('after');
  });

  it('does not time out a caller that was given its slot before its time, and leaves no timer behind', async () => {
    const clock = fakeTimers();
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 5, waitMs: 60, timers: clock.timers });
    const first = held();
    const running = bound.run(() => first.promise);
    const waiter = bound.run(() => Promise.resolve('served'));
    expect(clock.pending()).toBe(1);
    clock.advance(10);
    first.release('done');
    await running;
    expect(clock.pending()).toBe(0);
    clock.advance(1_000);
    expect(await waiter).toBe('served');
  });

  it('says it is a saturation in the way a context that cannot import this file can tell', async () => {
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 0, waitMs: 20, timers: fakeTimers().timers });
    const first = held();
    const running = bound.run(() => first.promise);
    const error = await bound.run(() => Promise.resolve('never')).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ saturated: true, reason: 'queue_full' });
    first.release('x');
    await running;
  });

  it('gives a slot that frees straight to the head of the queue, not to whoever calls next', async () => {
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 5, waitMs: 5_000, timers: fakeTimers().timers });
    const first = held();
    const order: string[] = [];
    const running = bound.run(() => first.promise);
    const queued = bound.run(async () => void order.push('queued'));
    first.release('x');
    const barger = bound.run(async () => void order.push('barger'));
    await Promise.all([running, queued, barger]);
    expect(order).toEqual(['queued', 'barger']);
  });

  it('frees the slot when the work fails, and passes the failure on', async () => {
    const bound = new BoundedWork({ concurrency: 1, queueLimit: 5, waitMs: 5_000, timers: fakeTimers().timers });
    const failing = held();
    const run = bound.run(() => failing.promise);
    const next = bound.run(() => Promise.resolve('next'));
    failing.fail(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(await next).toBe('next');
    expect(bound.inFlight).toBe(0);
  });

  it('refuses limits that do not make sense', () => {
    expect(() => new BoundedWork({ concurrency: 0, queueLimit: 1, waitMs: 1, timers: fakeTimers().timers })).toThrow(/concurrency/u);
    expect(() => new BoundedWork({ concurrency: 1.5, queueLimit: 1, waitMs: 1, timers: fakeTimers().timers })).toThrow(/concurrency/u);
    expect(() => new BoundedWork({ concurrency: 1, queueLimit: -1, waitMs: 1, timers: fakeTimers().timers })).toThrow(/queueLimit/u);
    expect(() => new BoundedWork({ concurrency: 1, queueLimit: 1.5, waitMs: 1, timers: fakeTimers().timers })).toThrow(/queueLimit/u);
    expect(() => new BoundedWork({ concurrency: 1, queueLimit: 1, waitMs: 0, timers: fakeTimers().timers })).toThrow(/waitMs/u);
    expect(() => new BoundedWork({ concurrency: 1, queueLimit: 1, waitMs: Number.NaN, timers: fakeTimers().timers })).toThrow(/waitMs/u);
  });
});
