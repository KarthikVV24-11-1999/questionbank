import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_CALLERS, HOST_FILES, STATE_ALLOWLIST, checkLearnShell } from './learn-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');

describe('the learner shell owns no attempt state (M6-47, M6-49, M6-50)', () => {
  it('finds none in the shipped source, and the scan is not vacuous', () => {
    const { violations, scannedFiles } = checkLearnShell(WORKSPACE, ['apps/learn/src']);
    expect(violations).toEqual([]);
    expect(scannedFiles).toBeGreaterThan(10);
  });

  it('names files and directories that exist, so the allowlist cannot rot', () => {
    for (const file of [...Object.keys(STATE_ALLOWLIST), ...HOST_FILES, ...ENGINE_CALLERS]) expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
  });

  it('every allowlisted file really holds state — an entry that holds none is a door left open for nothing', () => {
    const { violations } = checkLearnShell(WORKSPACE, ['apps/learn/src'], { stateAllowlist: [] });
    const files = new Set(violations.filter((violation) => violation.rule === 'M6_47_STATE_OUTSIDE_THE_ALLOWLIST').map((violation) => violation.file));
    expect([...files].sort()).toEqual(Object.keys(STATE_ALLOWLIST).sort());
  });

  describe('is red on a planted violation', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const run = (file: string) =>
      checkLearnShell(fixtures, ['as-learn'], { stateAllowlist: ['as-learn/permitted-dialog-state.tsx'], hostFiles: [], engineCallers: [] }).violations.filter((violation) => violation.file.endsWith(file));

    it('a component holding its own pick', () => {
      expect(run('planted-use-state.tsx').map((violation) => [violation.rule, violation.detail])).toEqual([
        ['M6_47_STATE_OUTSIDE_THE_ALLOWLIST', 'useState'],
        ['M6_47_ATTEMPT_NAMED_STATE', 'picked'],
      ]);
    });

    it('a ref holding a queue, and a state library', () => {
      expect(run('planted-ref-queue.tsx').map((violation) => violation.rule)).toEqual(['M6_47_STATE_OUTSIDE_THE_ALLOWLIST', 'M6_47_ATTEMPT_NAMED_STATE']);
      expect(run('planted-store-import.ts').map((violation) => violation.rule)).toEqual(['M6_47_STATE_OUTSIDE_THE_ALLOWLIST']);
    });

    it('state under an attempt\'s name is refused even in a file the allowlist admits', () => {
      const listed = checkLearnShell(fixtures, ['as-learn'], { stateAllowlist: ['as-learn/planted-use-state.tsx'], hostFiles: [], engineCallers: [] }).violations;
      expect(listed.filter((violation) => violation.file.endsWith('planted-use-state.tsx')).map((violation) => [violation.rule, violation.detail])).toEqual([['M6_47_ATTEMPT_NAMED_STATE', 'picked']]);
    });

    it('browser storage outside the host', () => {
      expect(run('planted-storage.ts').map((violation) => violation.rule)).toEqual(['M6_47_STORAGE_OUTSIDE_THE_HOST']);
    });

    it('a component calling the engine', () => {
      expect(run('planted-engine-call.ts').map((violation) => violation.rule)).toEqual(['M6_47_ENGINE_VALUE_IMPORT_OUTSIDE_THE_SESSION']);
    });

    it('a second notion of connectivity', () => {
      expect(run('planted-online.tsx').map((violation) => violation.rule)).toEqual(['M6_49_CONNECTIVITY_OUTSIDE_THE_HOST']);
    });

    it('a deadline from the wall clock', () => {
      expect(run('planted-clock.ts').map((violation) => [violation.rule, violation.detail])).toEqual([['M6_50_AMBIENT_TIME_OUTSIDE_THE_HOST', 'Date.now(']]);
    });

    it('but not a dialog flag, nor an engine type', () => {
      expect(run('permitted-dialog-state.tsx')).toEqual([]);
      expect(run('permitted-engine-type.ts')).toEqual([]);
    });

    it('and the host may touch what nobody else may', () => {
      const { violations } = checkLearnShell(fixtures, ['as-learn'], { stateAllowlist: ['as-learn/permitted-dialog-state.tsx'], hostFiles: ['as-learn/planted-storage.ts', 'as-learn/planted-clock.ts', 'as-learn/planted-online.tsx'], engineCallers: ['as-learn/'] });
      expect(violations.map((violation) => violation.file).filter((file) => /storage|clock|online|engine/u.test(file))).toEqual([]);
    });
  });
});
