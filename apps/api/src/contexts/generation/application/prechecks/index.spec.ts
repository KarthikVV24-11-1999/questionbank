import { describe, expect, it } from 'vitest';
import { versionId } from '../../../../testing/generation-fixtures.js';
import { BLOCKING_PRECHECKS, PRECHECKS, PRECHECK_IDS } from '../../domain/precheck-vocabulary.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import { BLOCKED_PRECHECKS, CONTENT_PROPOSAL_VALIDATION_SUCCESSOR, InvalidPrecheckConfigurationError, buildPrechecks, type PrecheckDependencies } from './index.js';
import { JUDGED_CHECKS, type PrecheckConfig } from './judge.js';

const CONFIG: PrecheckConfig = Object.fromEntries(
  JUDGED_CHECKS.map((check, index) => [check, { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20 + index) }]),
) as PrecheckConfig;

const deps = (config: PrecheckConfig = CONFIG): PrecheckDependencies => ({
  registry: {} as never,
  judge: { judge: async () => ok({ output: {} }) },
  syllabus: { read: async () => err(applicationError('Unavailable', 'X', 'x')) },
  config,
});

describe('every check in the vocabulary is run or declared blocked — never neither, never both', () => {
  const built = buildPrechecks(deps());
  const runs = built.runners.map((runner) => runner.check);
  const blocked = built.blocked.map((entry) => entry.check);

  // Asserted against literals, as sets: a loop over the lists cannot notice one
  // of them getting shorter.
  it('runs exactly these seven', () => {
    expect([...runs].sort()).toEqual(
      ['answer_verification', 'syllabus_scope', 'item_solution_key_consistency', 'distractor_validity', 'ambiguity_clarity', 'safety_appropriateness', 'provenance_licensing_completeness'].sort(),
    );
  });

  it('blocks exactly these five', () => {
    expect([...blocked].sort()).toEqual(['schema_validity', 'renderability', 'numeric_spec_completeness', 'duplicate_detection', 'difficulty_plausibility'].sort());
  });

  it('and between them are the twelve of the vocabulary, with nothing in both', () => {
    expect([...runs, ...blocked].sort()).toEqual([...PRECHECK_IDS].sort());
    expect(new Set([...runs, ...blocked]).size).toBe(12);
    expect(runs.filter((check) => blocked.includes(check))).toEqual([]);
  });

  it('has a single runner per check, each declaring the check it is', () => {
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('names one successor for every blocked check, and says why each is blocked', () => {
    expect(new Set(built.blocked.map((entry) => entry.successor))).toEqual(new Set([CONTENT_PROPOSAL_VALIDATION_SUCCESSOR]));
    expect(CONTENT_PROPOSAL_VALIDATION_SUCCESSOR).toContain('pure validator over proposed content');
    expect(CONTENT_PROPOSAL_VALIDATION_SUCCESSOR).toContain('duplicate check that accepts proposed content');
    for (const entry of BLOCKED_PRECHECKS) expect(entry.reason.length, entry.check).toBeGreaterThan(30);
  });
});

describe('what the blocked set costs, said plainly', () => {
  it('leaves blocking checks that cannot run: so nothing is acceptable through the battery until content\'s successor lands', () => {
    const blockedBlocking = BLOCKED_PRECHECKS.map((entry) => entry.check).filter((check) => (BLOCKING_PRECHECKS as readonly string[]).includes(check));
    expect(blockedBlocking.sort()).toEqual(['numeric_spec_completeness', 'renderability', 'schema_validity']);
  });

  it('while both advisory checks it cannot run (8 and 9) do not block acceptance in any case', () => {
    const advisory: readonly string[] = PRECHECKS.filter((check) => check.severity === 'advisory').map((check) => check.id);
    expect(BLOCKED_PRECHECKS.map((entry) => entry.check).filter((check) => advisory.includes(check)).sort()).toEqual(['difficulty_plausibility', 'duplicate_detection']);
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
