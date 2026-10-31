import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureConformance, readEventLog } from './event-conformance.js';

/**
 * The measurement itself (M7-63): replays what a run of the suites emitted through the real edge. It runs only under `pnpm run event-conformance`, which sets
 * the log marker and runs the suites that emit first; an ordinary `test` has no log to replay, and the check that the table is honest is `event-conformance-rules.spec.ts`.
 */
const LOG = process.env['QB_EVENT_LOG_REPLAY'];

describe.runIf(LOG !== undefined)('envelope conformance over a run of the suites', () => {
  it('admits at least 99% of the events the run emitted, and says how many that was', async () => {
    expect(existsSync(LOG!)).toBe(true);
    const lines = readEventLog(readFileSync(LOG!, 'utf8'));
    const measured = await measureConformance(lines.map((line) => line.event));
    const bySource = (source: string) => lines.filter((line) => line.source === source).length;
    const ratio = measured.conforming / measured.total;
    console.log(`EVENT CONFORMANCE ${JSON.stringify({ total: measured.total, learn: bySource('learn'), api: bySource('api'), browser: bySource('browser'), conforming: measured.conforming, ratio, byEvent: measured.byEvent, refused: measured.byReason })}`);
    expect(measured.total).toBeGreaterThan(0);
    expect(ratio).toBeGreaterThanOrEqual(0.99);
  });
});
