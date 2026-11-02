/**
 * A bound on how much expensive work runs at once (M8-08), and on how long anything waits for it.
 *
 * A rate limiter limits how often a client may ask; it says nothing about how many requests it has admitted are being served at this moment. For a password derive that is
 * the number that matters. Measured on the development machine, one scrypt at N=65536, r=8 holds 64 MiB for about 150 ms, and 200 derives started together peaked at about
 * 259 MiB and took 7.7 s: scrypt runs on libuv's thread pool, four threads by default, so what the pool allows to run is a ceiling on the memory. It is a ceiling somebody
 * else owns. Raise `UV_THREADPOOL_SIZE` to 16 for another reason and the same 200 derives peak at about a gibibyte. And whatever the size of the pool, those derives occupy
 * every thread of it for as long as they take, so file, DNS and compression work queued behind them waits too.
 *
 * So the bound is ours and sits under the pool: `concurrency` derives at once (memory: `concurrency` x 64 MiB), a queue of at most `queueLimit` behind them, and a wait of at
 * most `waitMs` for a slot. Past the queue, or past the wait, `run` rejects with `WorkSaturated` at once and the caller answers; nothing is held for ever. The defaults and what
 * they cost under real load are written in `platform/config/config.ts`. That the concurrency stays below the pool's size is not checked anywhere (D99 in docs/DEBT.md).
 *
 * Waiters are served in the order they arrived, and a slot that frees goes straight to the head of the queue rather than being left for whoever calls next.
 */
import type { DelayPort } from '../scheduling/scheduler.js';

export type SaturationReason = 'queue_full' | 'wait_timeout';

export class WorkSaturated extends Error {
  /** How a context that must not import this file recognises it: by what it says it is (see identity's `isSaturation`). */
  readonly saturated = true as const;
  constructor(readonly reason: SaturationReason) {
    super(`bounded work is saturated: ${reason}`);
    this.name = 'WorkSaturated';
  }
}

export interface BoundedWorkOptions {
  readonly concurrency: number;
  readonly queueLimit: number;
  readonly waitMs: number;
  /** The only way this file waits: the process's real timers, or a test's own. */
  readonly timers: DelayPort;
}

interface Waiter {
  readonly start: () => void;
  readonly fail: (error: WorkSaturated) => void;
  cancel: (() => void) | undefined;
}

export class BoundedWork {
  #running = 0;
  readonly #queue: Waiter[] = [];

  constructor(private readonly options: BoundedWorkOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('BoundedWork: concurrency must be a positive integer');
    if (!Number.isInteger(options.queueLimit) || options.queueLimit < 0) throw new Error('BoundedWork: queueLimit must be a whole number');
    if (!Number.isFinite(options.waitMs) || options.waitMs < 1) throw new Error('BoundedWork: waitMs must be positive');
  }

  get inFlight(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#queue.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running < this.options.concurrency) {
      this.#running += 1;
    } else {
      await this.#wait();
    }
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #wait(): Promise<void> {
    if (this.#queue.length >= this.options.queueLimit) return Promise.reject(new WorkSaturated('queue_full'));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { start: resolve, fail: reject, cancel: undefined };
      waiter.cancel = this.options.timers.after(this.options.waitMs, () => {
        const at = this.#queue.indexOf(waiter);
        if (at >= 0) this.#queue.splice(at, 1);
        waiter.fail(new WorkSaturated('wait_timeout'));
      });
      this.#queue.push(waiter);
    });
  }

  /** The slot passes to the head of the queue without being given back first, so a caller arriving at that moment cannot take it. */
  #release(): void {
    const next = this.#queue.shift();
    if (next === undefined) {
      this.#running -= 1;
      return;
    }
    next.cancel!();
    next.start();
  }
}
