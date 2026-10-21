import { describe, expect, it } from 'vitest';
import type { ResponseEvent } from './response-event.js';
import { randomEvents, seeded, shuffled } from './testing/generators.js';
import {
  acknowledge,
  createSyncQueue,
  enqueue,
  isSuspended,
  nextBatch,
  recordFailure,
  resumeSync,
  syncStatus,
  type SyncPolicy,
  type SyncQueue,
} from './sync-queue.js';

const POLICY: SyncPolicy = { batchSize: 3, baseDelayMs: 1000, maxDelayMs: 8000, maxConsecutiveFailures: 5 };

const ev = (eventId: string, sequence: number, attemptId = 'a1'): ResponseEvent => ({
  eventId,
  attemptId,
  slot: 'q1',
  sequence,
  monotonicMs: sequence,
  kind: 'select',
  answer: 'A',
});

function queueOf(events: readonly ResponseEvent[], policy = POLICY): SyncQueue {
  return events.reduce((q, e) => {
    const result = enqueue(q, e);
    if (!result.ok) throw new Error(result.reason);
    return result.queue;
  }, createSyncQueue('a1', policy));
}

const ids = (events: readonly ResponseEvent[]) => events.map((e) => e.eventId);

describe('creation', () => {
  it('accepts a sane policy', () => {
    expect(createSyncQueue('a1', POLICY).pending).toEqual([]);
  });

  it.each([
    ['a batch of zero', { ...POLICY, batchSize: 0 }],
    ['a negative base delay', { ...POLICY, baseDelayMs: -1 }],
    ['a max delay below the base', { ...POLICY, maxDelayMs: 500 }],
    ['no failures allowed', { ...POLICY, maxConsecutiveFailures: 0 }],
    ['a NaN batch size', { ...POLICY, batchSize: Number.NaN }],
  ])('refuses %s', (_name, policy) => {
    expect(() => createSyncQueue('a1', policy)).toThrow(RangeError);
  });
});

describe('what to send, and in what order', () => {
  it('offers events in sequence order whatever order they were enqueued in', () => {
    expect(ids(nextBatch(queueOf([ev('c', 3), ev('a', 1), ev('b', 2)]), 0))).toEqual(['a', 'b', 'c']);
  });

  it('offers at most a batch, from the head', () => {
    const queue = queueOf([1, 2, 3, 4, 5].map((n) => ev(`e${n}`, n)));
    expect(ids(nextBatch(queue, 0))).toEqual(['e1', 'e2', 'e3']);
  });

  it('offers nothing when empty', () => {
    expect(nextBatch(queueOf([]), 0)).toEqual([]);
  });

  it('ignores an event already pending, and one already acknowledged', () => {
    const queue = queueOf([ev('a', 1), ev('a', 1)]);
    expect(queue.pending).toHaveLength(1);
    const acked = acknowledge(queue, ['a']);
    const again = enqueue(acked, ev('a', 1));
    expect(again.ok && again.queue.pending).toEqual([]);
  });

  it('refuses an event from another attempt', () => {
    expect(enqueue(createSyncQueue('a1', POLICY), ev('x', 1, 'other'))).toEqual({
      ok: false,
      reason: 'wrong_attempt',
      eventId: 'x',
    });
  });

  it('does not mutate the queue it was given', () => {
    const queue = queueOf([ev('a', 1)]);
    enqueue(queue, ev('b', 2));
    acknowledge(queue, ['a']);
    recordFailure(queue, 0);
    expect(ids(queue.pending)).toEqual(['a']);
    expect(queue.consecutiveFailures).toBe(0);
  });
});

describe('redelivery after an interruption', () => {
  it('offers the same unacknowledged events again, in order, however often it is asked', () => {
    const queue = queueOf([1, 2, 3, 4].map((n) => ev(`e${n}`, n)));
    const first = ids(nextBatch(queue, 0));
    expect(ids(nextBatch(queue, 0))).toEqual(first);
    expect(ids(nextBatch(queue, 0))).toEqual(first);
  });

  it('after a partial acknowledgement, resumes from the first unacknowledged event', () => {
    const queue = queueOf([1, 2, 3, 4, 5].map((n) => ev(`e${n}`, n)));
    const afterPartial = acknowledge(queue, ['e1', 'e2']);
    expect(ids(nextBatch(afterPartial, 0))).toEqual(['e3', 'e4', 'e5']);
  });

  it('an acknowledgement that skips the head leaves the head to be sent first', () => {
    const queue = queueOf([1, 2, 3].map((n) => ev(`e${n}`, n)));
    expect(ids(nextBatch(acknowledge(queue, ['e2']), 0))).toEqual(['e1', 'e3']);
  });

  it('acknowledging twice is harmless', () => {
    const queue = queueOf([1, 2, 3].map((n) => ev(`e${n}`, n)));
    const once = acknowledge(queue, ['e1']);
    const twice = acknowledge(once, ['e1']);
    expect(twice).toEqual(once);
    expect(ids(twice.pending)).toEqual(['e2', 'e3']);
  });

  it('acknowledging an id the queue never held neither throws nor disturbs the rest', () => {
    const queue = queueOf([ev('a', 1)]);
    expect(ids(acknowledge(queue, ['ghost']).pending)).toEqual(['a']);
  });

  it('an interruption drops nothing: failure then success delivers everything exactly once', () => {
    let queue = queueOf([1, 2, 3, 4].map((n) => ev(`e${n}`, n)));
    const delivered: string[] = [];
    let now = 0;
    let attempts = 0;
    while (queue.pending.length > 0) {
      attempts += 1;
      const batch = nextBatch(queue, now);
      if (batch.length === 0) {
        now += 1000;
      } else if (attempts % 2 === 1) {
        queue = recordFailure(queue, now);
      } else {
        delivered.push(...ids(batch));
        queue = acknowledge(queue, ids(batch));
      }
      if (attempts > 100) throw new Error('did not converge');
    }
    expect(delivered).toEqual(['e1', 'e2', 'e3', 'e4']);
  });
});

describe('when sending fails', () => {
  const failTimes = (queue: SyncQueue, times: number, now = 0) => Array.from({ length: times }).reduce<SyncQueue>((q) => recordFailure(q, now), queue);

  it('backs off exponentially from the base delay, up to the cap', () => {
    const queue = queueOf([ev('a', 1)]);
    expect([1, 2, 3, 4].map((n) => failTimes(queue, n, 100).retryAtMs)).toEqual([1100, 2100, 4100, 8100]);
    expect(failTimes(queue, 4, 100).retryAtMs).toBe(100 + POLICY.maxDelayMs);
  });

  it('offers nothing until the retry time, then the same events again', () => {
    const failed = recordFailure(queueOf([ev('a', 1)]), 100);
    expect(nextBatch(failed, 1099)).toEqual([]);
    expect(ids(nextBatch(failed, 1100))).toEqual(['a']);
  });

  it('keeps every event through any number of failures', () => {
    const queue = failTimes(queueOf([1, 2, 3].map((n) => ev(`e${n}`, n))), 50);
    expect(ids(queue.pending)).toEqual(['e1', 'e2', 'e3']);
  });

  it('gives up retrying after the policy limit, but never the events', () => {
    const queue = queueOf([ev('a', 1)]);
    const almost = failTimes(queue, 4);
    expect(isSuspended(almost)).toBe(false);
    const gaveUp = failTimes(queue, 5);
    expect(isSuspended(gaveUp)).toBe(true);
    expect(nextBatch(gaveUp, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(ids(gaveUp.pending)).toEqual(['a']);
  });

  it('resumes on request: the failure count and backoff clear and the events are offered again', () => {
    const resumed = resumeSync(failTimes(queueOf([ev('a', 1)]), 5, 100));
    expect(isSuspended(resumed)).toBe(false);
    expect(ids(nextBatch(resumed, 0))).toEqual(['a']);
  });

  it('a success clears the failure count, so failures must be consecutive to give up', () => {
    let queue = failTimes(queueOf([ev('a', 1), ev('b', 2)]), 4);
    queue = acknowledge(queue, ['a']);
    expect(queue.consecutiveFailures).toBe(0);
    expect(isSuspended(failTimes(queue, 4))).toBe(false);
  });
});

describe('the sync indicator status', () => {
  it('is idle when nothing is waiting, pending when something is, and calm in between', () => {
    expect(syncStatus(queueOf([]), 0)).toBe('idle');
    expect(syncStatus(queueOf([ev('a', 1)]), 0)).toBe('pending');
  });

  it('is backing off between a failure and its retry, then pending again', () => {
    const failed = recordFailure(queueOf([ev('a', 1)]), 0);
    expect(syncStatus(failed, 500)).toBe('backing_off');
    expect(syncStatus(failed, 1000)).toBe('pending');
  });

  it('is suspended once it has given up, and idle if there is nothing left to send', () => {
    const gaveUp = Array.from({ length: 5 }).reduce<SyncQueue>((q) => recordFailure(q, 0), queueOf([ev('a', 1)]));
    expect(syncStatus(gaveUp, 0)).toBe('suspended');
    expect(syncStatus(acknowledge(gaveUp, ['a']), 0)).toBe('idle');
  });
});

describe('never drops an event it has not been told was acknowledged', () => {
  /** An operation returns the new queue and the ids it told the queue were acknowledged. */
  type Operation = (queue: SyncQueue, now: number) => { readonly queue: SyncQueue; readonly told: readonly string[] };

  const realOperations: Operation[] = [
    (queue, now) => ({ queue: recordFailure(queue, now), told: [] }),
    (queue) => ({ queue: resumeSync(queue), told: [] }),
    (queue) => ({ queue, told: [] }),
    (queue, now) => {
      const told = ids(nextBatch(queue, now));
      return { queue: acknowledge(queue, told), told };
    },
    (queue, now) => {
      // a flaky link confirms only part of the batch
      const told = ids(nextBatch(queue, now)).slice(1);
      return { queue: acknowledge(queue, told), told };
    },
    (queue, now) => {
      const told = ids(nextBatch(queue, now));
      return { queue: acknowledge(acknowledge(queue, told), told), told };
    },
  ];

  /** Planted violation: a failed send throws the batch away instead of keeping it. */
  const discardBatchOnFailure: Operation = (queue, now) => {
    const failed = recordFailure(queue, now);
    return { queue: { ...failed, pending: failed.pending.slice(queue.policy.batchSize) }, told: [] };
  };

  /** Drives random operations; returns the first broken invariant, or null. */
  function firstViolation(operations: readonly Operation[], seeds: number): string | null {
    for (let seed = 1; seed <= seeds; seed += 1) {
      const random = seeded(seed);
      let queue = queueOf([]);
      let toEnqueue = shuffled(randomEvents(random, { count: 25 }), random);
      let now = 0;
      for (let step = 0; step < 120; step += 1) {
        now += Math.floor(random() * 3000);
        if (toEnqueue.length > 0 && random() < 0.4) {
          const result = enqueue(queue, toEnqueue[0] as ResponseEvent);
          toEnqueue = toEnqueue.slice(1);
          if (result.ok) queue = result.queue;
          continue;
        }
        const before = ids(queue.pending);
        const outcome = (operations[Math.floor(random() * operations.length)] as Operation)(queue, now);
        queue = outcome.queue;
        const after = new Set(ids(queue.pending));
        const left = before.filter((id) => !after.has(id));
        const unexplained = left.filter((id) => !outcome.told.includes(id));
        if (unexplained.length > 0) return `seed ${seed}: ${unexplained[0]} left the queue without being acknowledged`;
        const order = ids(queue.pending);
        const sorted = ids([...queue.pending].sort((a, b) => a.sequence - b.sequence));
        if (order.join() !== sorted.join()) return `seed ${seed}: pending is out of order`;
      }
    }
    return null;
  }

  it('over 150 random runs of failures, partial acks, double acks and restarts, only acknowledged events leave and order holds', () => {
    expect(firstViolation(realOperations, 150)).toBeNull();
  });

  it('the check can fail: a queue that discards its batch on failure is caught, naming the event', () => {
    expect(firstViolation([...realOperations, discardBatchOnFailure], 150)).toMatch(
      /^seed \d+: e\d+ left the queue without being acknowledged$/u,
    );
  });
});
