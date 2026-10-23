import type { TimerPort } from './scheduler.js';

/**
 * The real timers, for the process to hand the scheduler. The only place a timer is started: everything below it takes the
 * moment as a parameter, and an unreferenced interval never keeps the process alive on its own.
 */
export const systemTimers: TimerPort = {
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return () => clearInterval(handle);
  },
};
