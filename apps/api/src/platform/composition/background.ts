import type { OutboxRelay } from '../outbox/relay.js';
import type { Scheduler } from '../scheduling/scheduler.js';

/**
 * What the composition root builds for the process to run beside the HTTP server (M6-38, M6-42): the outbox relay and the scheduler
 * that drives it and every sweep. The application only *builds* them — it starts no timer — so a test that creates the application
 * schedules nothing, and one that wants a drain or a tick takes this from the application and passes the moment itself.
 * `main.ts` starts the scheduler on real timers when `BACKGROUND_JOBS_ENABLED` says so.
 */
export interface Background {
  readonly relay: OutboxRelay;
  readonly scheduler: Scheduler;
}

export const BACKGROUND = Symbol('BACKGROUND');
