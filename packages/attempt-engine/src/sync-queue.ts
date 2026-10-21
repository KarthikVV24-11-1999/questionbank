import { compareEvents, type ResponseEvent } from './response-event.js';

/**
 * Decides what to send, in what order, and when to stop trying. It performs
 * no sending: the caller takes a batch, sends it however it likes, and tells
 * the queue what happened. Time arrives as a parameter, the same way it does
 * for the timer, and retry delays carry no jitter because the engine has no
 * source of randomness — a caller that wants jitter adds it to the delay it
 * waits.
 *
 * The queue's one promise: an event leaves it only when it has been told the
 * event was acknowledged. Failure, interruption, retry, a restart and a
 * second acknowledgement never drop one.
 */
export interface SyncPolicy {
  readonly batchSize: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** After this many failures in a row the queue stops offering batches until resumed. */
  readonly maxConsecutiveFailures: number;
}

export interface SyncQueue {
  readonly attemptId: string;
  readonly policy: SyncPolicy;
  /** Unacknowledged events in canonical order — the order they are delivered in. */
  readonly pending: readonly ResponseEvent[];
  /** Ids already acknowledged, so a re-enqueued event is not sent again. */
  readonly acknowledged: ReadonlySet<string>;
  readonly consecutiveFailures: number;
  readonly retryAtMs: number;
}

export function createSyncQueue(attemptId: string, policy: SyncPolicy): SyncQueue {
  if (
    !(policy.batchSize >= 1) ||
    !(policy.baseDelayMs >= 0) ||
    !(policy.maxDelayMs >= policy.baseDelayMs) ||
    !(policy.maxConsecutiveFailures >= 1)
  ) {
    throw new RangeError('invalid sync policy');
  }
  return { attemptId, policy, pending: [], acknowledged: new Set(), consecutiveFailures: 0, retryAtMs: 0 };
}

export type EnqueueResult =
  | { readonly ok: true; readonly queue: SyncQueue }
  | { readonly ok: false; readonly reason: 'wrong_attempt'; readonly eventId: string };

/** Adds an event. One already pending or already acknowledged is ignored. */
export function enqueue(queue: SyncQueue, event: ResponseEvent): EnqueueResult {
  if (event.attemptId !== queue.attemptId) return { ok: false, reason: 'wrong_attempt', eventId: event.eventId };
  if (queue.acknowledged.has(event.eventId) || queue.pending.some((p) => p.eventId === event.eventId)) {
    return { ok: true, queue };
  }
  return { ok: true, queue: { ...queue, pending: [...queue.pending, event].sort(compareEvents) } };
}

/**
 * The next events to send: the head of the queue, in order, up to the batch
 * size. It changes nothing, so asking again after an interruption offers the
 * same unacknowledged events again. Nothing is offered while backing off or
 * after the queue has given up.
 */
export function nextBatch(queue: SyncQueue, nowMs: number): readonly ResponseEvent[] {
  if (isSuspended(queue) || nowMs < queue.retryAtMs) return [];
  return queue.pending.slice(0, queue.policy.batchSize);
}

/**
 * The server confirmed these events. They leave the queue; anything else
 * stays, in order. Acknowledging an id twice, or one the queue never held,
 * changes nothing further. Success clears the failure count and the backoff.
 */
export function acknowledge(queue: SyncQueue, eventIds: readonly string[]): SyncQueue {
  const confirmed = new Set(eventIds);
  return {
    ...queue,
    pending: queue.pending.filter((event) => !confirmed.has(event.eventId)),
    acknowledged: new Set([...queue.acknowledged, ...confirmed]),
    consecutiveFailures: 0,
    retryAtMs: 0,
  };
}

/**
 * A send failed. Nothing is dropped; the queue backs off exponentially, and
 * after `maxConsecutiveFailures` in a row it stops offering batches until
 * `resumeSync` — it gives up retrying, never gives up the events.
 */
export function recordFailure(queue: SyncQueue, nowMs: number): SyncQueue {
  const consecutiveFailures = queue.consecutiveFailures + 1;
  const { baseDelayMs, maxDelayMs } = queue.policy;
  const delay = Math.min(baseDelayMs * 2 ** (consecutiveFailures - 1), maxDelayMs);
  return { ...queue, consecutiveFailures, retryAtMs: nowMs + delay };
}

export function isSuspended(queue: SyncQueue): boolean {
  return queue.consecutiveFailures >= queue.policy.maxConsecutiveFailures;
}

/**
 * Clears the failure count and the backoff — after the learner asks to retry,
 * the network returns, or the app restarts on a monotonic clock with a new
 * origin, where a stale retry time would otherwise block sending.
 */
export function resumeSync(queue: SyncQueue): SyncQueue {
  return { ...queue, consecutiveFailures: 0, retryAtMs: 0 };
}

export type SyncStatus = 'idle' | 'pending' | 'backing_off' | 'suspended';

/** What a calm sync indicator shows. */
export function syncStatus(queue: SyncQueue, nowMs: number): SyncStatus {
  if (queue.pending.length === 0) return 'idle';
  if (isSuspended(queue)) return 'suspended';
  return nowMs < queue.retryAtMs ? 'backing_off' : 'pending';
}
