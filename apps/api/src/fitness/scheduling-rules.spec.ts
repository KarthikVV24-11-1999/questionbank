import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOCK_FREE_PATHS, TIMER_PORT_FILES, checkSchedulingDiscipline } from './scheduling-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');

describe('the background jobs\' discipline (M6-38, M6-42)', () => {
  it('finds no timer outside the port, and no clock read in the relay or the scheduler, in the shipped source', () => {
    expect(checkSchedulingDiscipline(WORKSPACE, ['apps/api/src'])).toEqual([]);
  });

  it('names files that exist, so the exemptions and the clock-free set cannot rot', () => {
    for (const file of [...TIMER_PORT_FILES, ...CLOCK_FREE_PATHS]) expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
  });

  describe('is red on a planted violation', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const run = (file: string) =>
      checkSchedulingDiscipline(fixtures, ['as-scheduling'], { timerPort: [], clockFree: ['as-scheduling/'] }).filter((violation) => violation.file.endsWith(file));

    it('a module that starts its own timer', () => {
      expect(run('planted-timer.ts')).toEqual([expect.objectContaining({ rule: 'M6_42_TIMER_STARTED_OUTSIDE_THE_PORT', detail: 'setInterval(' })]);
    });

    it('a relay or scheduler that reads the clock: Date.now and new Date()', () => {
      expect(run('planted-clock-read.ts').map((violation) => [violation.rule, violation.detail])).toEqual([
        ['M6_38_CLOCK_READ_IN_THE_RELAY_OR_SCHEDULER', 'Date.now('],
        ['M6_38_CLOCK_READ_IN_THE_RELAY_OR_SCHEDULER', 'new Date()'],
      ]);
    });

    it('but not time that was supplied', () => {
      expect(run('permitted-supplied-clock.ts')).toEqual([]);
    });
  });

  it('lets the port itself start a timer', () => {
    expect(checkSchedulingDiscipline(WORKSPACE, ['apps/api/src/platform/scheduling'], { clockFree: [] })).toEqual([]);
  });
});
