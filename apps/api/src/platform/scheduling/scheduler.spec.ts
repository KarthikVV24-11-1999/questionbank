import { describe, expect, it } from 'vitest';
import { Scheduler, type BackgroundJob, type TimerPort } from './scheduler.js';

const T0 = new Date('2026-10-23T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function job(name: string, everyMs: number, log: string[], behaviour: () => Promise<void> = async () => undefined): BackgroundJob {
  return { name, everyMs, run: async (now) => { log.push(`${name}@${now.getTime() - T0.getTime()}`); await behaviour(); } };
}

describe('the scheduler, with the moment supplied (M6-42)', () => {
  it('runs everything on the first tick, and each job again only when its own interval has passed', async () => {
    const log: string[] = [];
    const scheduler = new Scheduler([job('fast', 1_000, log), job('slow', 10_000, log)]);
    await scheduler.tick(T0);
    await scheduler.tick(at(999));
    await scheduler.tick(at(1_000));
    await scheduler.tick(at(5_000));
    await scheduler.tick(at(10_000));
    expect(log).toEqual(['fast@0', 'slow@0', 'fast@1000', 'fast@5000', 'fast@10000', 'slow@10000']);
  });

  it('says what happened to each job', async () => {
    const report = await new Scheduler([job('a', 1_000, [])]).tick(T0);
    expect(report).toEqual({ at: '2026-10-23T10:00:00.000Z', jobs: [{ name: 'a', outcome: 'ran' }] });
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('keeps going when a job throws, reports it, and tries it again when it next comes due', async () => {
    const log: string[] = [];
    let fail = true;
    const scheduler = new Scheduler([
      job('flaky', 1_000, log, async () => { if (fail) throw new Error('the database was away'); }),
      job('steady', 1_000, log),
    ]);
    const first = await scheduler.tick(T0);
    expect(first.jobs).toEqual([{ name: 'flaky', outcome: 'failed', error: 'the database was away' }, { name: 'steady', outcome: 'ran' }]);
    fail = false;
    expect((await scheduler.tick(at(500))).jobs).toEqual([]); // a failed job waits its interval like any other
    expect((await scheduler.tick(at(1_000))).jobs.map((j) => j.outcome)).toEqual(['ran', 'ran']);
  });

  it('describes a thrown value that is not an Error', async () => {
    const scheduler = new Scheduler([{ name: 'odd', everyMs: 1, run: async () => { throw 'plain text'; } }]);
    expect((await scheduler.tick(T0)).jobs[0]).toEqual({ name: 'odd', outcome: 'failed', error: 'plain text' });
  });

  it('does not start a job again while the last run of it is still going', async () => {
    let release: () => void = () => undefined;
    const log: string[] = [];
    const scheduler = new Scheduler([job('long', 1_000, log, () => new Promise<void>((resolve) => (release = resolve)))]);
    const first = scheduler.tick(T0);
    // a second tick while the first is mid-job: the job is due again, but is running
    const second = await scheduler.tick(at(5_000));
    expect(second.jobs).toEqual([{ name: 'long', outcome: 'skipped-running' }]);
    release();
    await first;
    expect(log).toEqual(['long@0']);
  });

  it('refuses a job with no interval, and two jobs of one name', () => {
    expect(() => new Scheduler([job('a', 0, [])])).toThrow('positive interval');
    expect(() => new Scheduler([job('a', Number.NaN, [])])).toThrow('positive interval');
    expect(() => new Scheduler([job('a', 1, []), job('a', 1, [])])).toThrow('two jobs are named a');
    expect(new Scheduler([job('a', 1, []), job('b', 1, [])]).names).toEqual(['a', 'b']);
  });

  describe('started on timers', () => {
    function fakeTimers() {
      let fn: () => void = () => undefined;
      let stopped = false;
      const port: TimerPort = { every: (_ms, callback) => { fn = callback; return () => { stopped = true; }; } };
      return { port, fire: () => fn(), stopped: () => stopped };
    }

    it('ticks at each firing with the moment it is given, and hands the report on', async () => {
      const log: string[] = [];
      const timers = fakeTimers();
      const reports: string[] = [];
      let nowMs = 0;
      const stop = new Scheduler([job('a', 1_000, log)]).start(timers.port, () => at(nowMs), 100, (report) => reports.push(report.at));
      timers.fire();
      await new Promise((resolve) => setImmediate(resolve));
      nowMs = 2_000;
      timers.fire();
      await new Promise((resolve) => setImmediate(resolve));
      expect(log).toEqual(['a@0', 'a@2000']);
      expect(reports).toEqual([T0.toISOString(), at(2_000).toISOString()]);
      stop();
      expect(timers.stopped()).toBe(true);
    });

    it('does not begin a tick while the last is unfinished', async () => {
      let release: () => void = () => undefined;
      const log: string[] = [];
      const timers = fakeTimers();
      new Scheduler([job('a', 1, log, () => new Promise<void>((resolve) => (release = resolve)))]).start(timers.port, () => T0, 100);
      timers.fire();
      timers.fire();
      timers.fire();
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(log).toEqual(['a@0']);
    });

    it('works with the default report handler', async () => {
      const timers = fakeTimers();
      new Scheduler([job('a', 1, [])]).start(timers.port, () => T0, 100);
      timers.fire();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
