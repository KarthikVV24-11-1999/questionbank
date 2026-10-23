/**
 * The in-process scheduler (M6-42).
 *
 * D36 was recorded as blocked on "a deployed environment with a scheduler". The part of that which was always buildable is a
 * loop that asks, at intervals, whether a job is due and runs it; the sweeps themselves are ordinary idempotent commands that
 * take the moment as a parameter. This is that loop, with its time supplied: `tick(now)` runs whatever is due as of `now` and
 * nothing here reads a clock or sleeps, so a job coming due, running late or overlapping itself is tested by passing a later `now`.
 *
 * What it is and is not:
 *
 *   - **A trigger, not a coordinator.** Each instance of the application runs its own copy. That is safe because everything a job
 *     does is idempotent or claims its work (the relay with `FOR UPDATE SKIP LOCKED`; the sweeps find only what is still to do and
 *     move it under a state guard), so two instances racing do the work once between them. It does not elect a leader.
 *   - **One failure does not stop the rest.** A job that throws is reported, and tried again when it next comes due.
 *   - **A job does not overlap itself.** One still running when its next turn comes is skipped for that tick.
 *   - **First tick runs everything.** A freshly started process has no memory of when anything last ran, and a sweep it runs early is
 *     harmless: they find only what is due.
 *
 * Starting it on real timers is the process's job (`main.ts`), through `TimerPort`; the application never starts one on its own, so
 * a test that creates the application schedules nothing.
 */
export interface BackgroundJob {
  readonly name: string;
  readonly everyMs: number;
  run(now: Date): Promise<void>;
}

export interface TimerPort {
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

export interface JobOutcome {
  readonly name: string;
  readonly outcome: 'ran' | 'failed' | 'skipped-running';
  readonly error?: string;
}

export interface TickReport {
  readonly at: string;
  readonly jobs: readonly JobOutcome[];
}

export class Scheduler {
  readonly #lastStartedAt = new Map<string, number>();
  readonly #running = new Set<string>();

  constructor(private readonly jobs: readonly BackgroundJob[]) {
    const names = new Set<string>();
    for (const job of jobs) {
      if (job.everyMs < 1 || !Number.isFinite(job.everyMs)) throw new RangeError(`job ${job.name} needs a positive interval`);
      if (names.has(job.name)) throw new RangeError(`two jobs are named ${job.name}`);
      names.add(job.name);
    }
  }

  get names(): readonly string[] {
    return this.jobs.map((job) => job.name);
  }

  /** Runs every job due as of `now`, one after another, and says what happened to each. */
  async tick(now: Date): Promise<TickReport> {
    const outcomes: JobOutcome[] = [];
    for (const job of this.jobs) {
      const last = this.#lastStartedAt.get(job.name);
      if (last !== undefined && now.getTime() - last < job.everyMs) continue;
      if (this.#running.has(job.name)) {
        outcomes.push({ name: job.name, outcome: 'skipped-running' });
        continue;
      }
      this.#running.add(job.name);
      this.#lastStartedAt.set(job.name, now.getTime());
      try {
        await job.run(now);
        outcomes.push({ name: job.name, outcome: 'ran' });
      } catch (error) {
        outcomes.push({ name: job.name, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.#running.delete(job.name);
      }
    }
    return Object.freeze({ at: now.toISOString(), jobs: Object.freeze(outcomes) });
  }

  /**
   * Ticks every `tickMs` on `timers`, reading the moment from `now`. Returns the stop function. A tick that is still running when the
   * next fires is not started again (the jobs guard themselves, and this guards the tick). `onTick` is how a process logs what happened.
   */
  start(timers: TimerPort, now: () => Date, tickMs: number, onTick: (report: TickReport) => void = () => undefined): () => void {
    let ticking = false;
    return timers.every(tickMs, () => {
      if (ticking) return;
      ticking = true;
      void this.tick(now())
        .then(onTick)
        .finally(() => {
          ticking = false;
        });
    });
  }
}
