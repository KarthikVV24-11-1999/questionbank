import { describe, expect, it } from 'vitest';
import { versionId, USAGE } from '../../../../testing/generation-fixtures.js';
import { BLOCKING_PRECHECKS, PRECHECKS, PRECHECK_IDS } from '../../domain/precheck-vocabulary.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import {
  BLOCKED_PRECHECKS,
  DIFFICULTY_PRIOR_SUCCESSOR,
  InvalidPrecheckConfigurationError,
  UNCONFIGURED_SUCCESSOR,
  buildPrechecks,
  unconfiguredPrechecks,
  type PrecheckDependencies,
} from './index.js';
import { JUDGED_CHECKS, type PrecheckConfig } from './judge.js';

const CONFIG: PrecheckConfig = Object.fromEntries(
  JUDGED_CHECKS.map((check, index) => [check, { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20 + index) }]),
) as PrecheckConfig;

const deps = (config: PrecheckConfig = CONFIG): PrecheckDependencies => ({
  registry: {} as never,
  judge: { judge: async () => ok({ usage: USAGE, output: {} }) },
  syllabus: { read: async () => err(applicationError('Unavailable', 'X', 'x')) },
  content: {} as never,
  clock: { now: () => new Date('2026-10-16T09:30:00.000Z') },
  config,
});

describe('every check in the vocabulary is run or declared blocked — never neither, never both', () => {
  const built = buildPrechecks(deps());
  const runs = built.runners.map((runner) => runner.check);
  const blocked = built.blocked.map((entry) => entry.check);

  // Asserted against literals, as sets: a loop over the lists cannot notice one
  // of them getting shorter.
  it('runs exactly these eleven', () => {
    expect([...runs].sort()).toEqual(
      [
        'answer_verification', 'syllabus_scope', 'item_solution_key_consistency', 'distractor_validity', 'ambiguity_clarity',
        'safety_appropriateness', 'provenance_licensing_completeness', 'schema_validity', 'renderability', 'numeric_spec_completeness', 'duplicate_detection',
      ].sort(),
    );
  });

  it('blocks exactly this one', () => {
    expect([...blocked]).toEqual(['difficulty_plausibility']);
  });

  it('and between them are the twelve of the vocabulary, with nothing in both', () => {
    expect([...runs, ...blocked].sort()).toEqual([...PRECHECK_IDS].sort());
    expect(new Set([...runs, ...blocked]).size).toBe(12);
    expect(runs.filter((check) => blocked.includes(check))).toEqual([]);
  });

  it('has a single runner per check, each declaring the check it is', () => {
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('names a successor for the check that remains blocked, and says why', () => {
    expect(new Set(built.blocked.map((entry) => entry.successor))).toEqual(new Set([DIFFICULTY_PRIOR_SUCCESSOR]));
    expect(DIFFICULTY_PRIOR_SUCCESSOR).toContain('difficulty prior over proposed content');
    for (const entry of BLOCKED_PRECHECKS) expect(entry.reason.length, entry.check).toBeGreaterThan(30);
  });
});

describe('what the blocked set costs, said plainly', () => {
  it('is nothing that blocks acceptance: the one check still blocked is advisory', () => {
    const blockedBlocking = BLOCKED_PRECHECKS.map((entry) => entry.check).filter((check) => (BLOCKING_PRECHECKS as readonly string[]).includes(check));
    expect(blockedBlocking).toEqual([]);
    expect(PRECHECKS.find((check) => check.id === 'difficulty_plausibility')?.severity).toBe('advisory');
  });
});

describe('a configuration that cannot be right does not build', () => {
  it('refuses two checks sharing a prompt, at build time, naming the rule', () => {
    const shared = { ...CONFIG, safety_appropriateness: { ...CONFIG.safety_appropriateness, promptVersionId: CONFIG.ambiguity_clarity.promptVersionId } };
    expect(() => buildPrechecks(deps(shared))).toThrow(InvalidPrecheckConfigurationError);
    expect(() => buildPrechecks(deps(shared))).toThrow(/PRECHECK_PROMPTS_NOT_DISTINCT/u);
  });

  it('refuses a label where a registry id belongs', () => {
    const labelled = { ...CONFIG, answer_verification: { ...CONFIG.answer_verification, promptVersionId: 'verify-v2' } };
    expect(() => buildPrechecks(deps(labelled))).toThrow(/PRECHECK_CONFIG_INVALID/u);
  });

  it('names the failure so a boot log says which', () => {
    const error = new InvalidPrecheckConfigurationError('X', 'why');
    expect(error.name).toBe('InvalidPrecheckConfigurationError');
    expect(error.message).toBe('the pre-check battery cannot be built: X: why');
  });
});

describe('a deployment that supplied no pre-check configuration (M5-37)', () => {
  const unconfigured = unconfiguredPrechecks();

  it('runs nothing', () => {
    expect(unconfigured.runners).toEqual([]);
  });

  it('declares all twelve blocked, as a set equal to the vocabulary — a check is never merely absent', () => {
    expect([...unconfigured.blocked.map((entry) => entry.check)].sort()).toEqual([...PRECHECK_IDS].sort());
    expect(unconfigured.blocked).toHaveLength(12);
  });

  it('gives the eleven that wait on configuration one reason and one named successor', () => {
    const waiting = unconfigured.blocked.filter((entry) => entry.check !== 'difficulty_plausibility');
    expect(waiting).toHaveLength(11);
    for (const entry of waiting) {
      expect(entry.reason).toContain('no pre-check configuration was supplied');
      expect(entry.successor).toBe(UNCONFIGURED_SUCCESSOR);
    }
  });

  it('leaves check 9 with its own permanent reason rather than a reason that configuration would fix', () => {
    const difficulty = unconfigured.blocked.find((entry) => entry.check === 'difficulty_plausibility');
    expect(difficulty).toEqual(BLOCKED_PRECHECKS[0]);
    expect(difficulty?.successor).toBe(DIFFICULTY_PRIOR_SUCCESSOR);
  });
});
