import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, versionId, USAGE } from '../../../../testing/generation-fixtures.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { JudgementProvider, JudgementRequest } from '../ports.js';
import { JUDGED_CHECKS, judgeIndependently, requireIndependentPrompt, validatePrecheckConfig, type PrecheckConfig } from './judge.js';

const CONFIG: PrecheckConfig = Object.fromEntries(
  JUDGED_CHECKS.map((check, index) => [check, { modelVersionId: versionId('model', 50 + index), promptVersionId: versionId('prompt', 50 + index) }]),
) as PrecheckConfig;

describe('F29 — a check does not run under the prompt its candidate was generated with', () => {
  it('passes a prompt that differs', () => {
    expect(expectValue(requireIndependentPrompt('answer_verification', versionId('prompt', 7), versionId('prompt', 20)))).toBe(true);
  });

  // The planted violation: a verification that reuses the generation prompt.
  it('is red on a check reusing the generation prompt version, naming the check and the rule', () => {
    const generation = versionId('prompt', 7);
    const failure = expectError(requireIndependentPrompt('answer_verification', generation, generation));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('CHECK_REUSES_GENERATION_PROMPT');
    expect(failure.message).toContain('answer_verification');
    expect(failure.message).toContain('F29');
    expect(failure.location).toBe('promptVersionId');
  });
});

describe('the gateway every judged check goes through', () => {
  const candidate = aCandidate(aRun({ promptVersionId: versionId('prompt', 7) }));
  const recording = (): { provider: JudgementProvider; asked: JudgementRequest[] } => {
    const asked: JudgementRequest[] = [];
    return { asked, provider: { judge: async (request) => (asked.push(request), ok({ usage: USAGE, output: { answer: 'b' } })) } };
  };

  it('puts the question to the provider under the check’s own model and prompt', async () => {
    const { provider, asked } = recording();
    const config = { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20) };
    expectValue(await judgeIndependently(provider, candidate, 'answer_verification', config, { q: 1 }));
    expect(asked).toEqual([{ budgetScope: { feature: 'generation', runId: candidate.pin.runId }, ...config, input: { q: 1 } }]);
  });

  it('refuses before the provider is touched when the prompt is the candidate’s own', async () => {
    const { provider, asked } = recording();
    const reusing = { modelVersionId: versionId('model', 5), promptVersionId: candidate.pin.promptVersionId };
    expect(expectError(await judgeIndependently(provider, candidate, 'answer_verification', reusing, {})).code).toBe('CHECK_REUSES_GENERATION_PROMPT');
    expect(asked).toEqual([]);
  });

  it('returns the provider’s own failure unchanged', async () => {
    const down = applicationError('Unavailable', 'PROVIDER_DOWN', 'later');
    const provider: JudgementProvider = { judge: async () => err(down) };
    const config = { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20) };
    expect(expectError(await judgeIndependently(provider, candidate, 'answer_verification', config, {}))).toBe(down);
  });
});

describe('the configuration, validated when it is built', () => {
  it('accepts one where every judged check has its own registry-shaped model and prompt', () => {
    expect(expectValue(validatePrecheckConfig(CONFIG))).toBe(CONFIG);
    expect(Object.keys(CONFIG).sort()).toEqual([...JUDGED_CHECKS].sort());
  });

  it('refuses a model or prompt that is not a UUID, naming which', () => {
    for (const field of ['modelVersionId', 'promptVersionId'] as const) {
      const bad = { ...CONFIG, ambiguity_clarity: { ...CONFIG.ambiguity_clarity, [field]: 'prompt-v3' } };
      const failure = expectError(validatePrecheckConfig(bad));
      expect(failure.code).toBe('PRECHECK_CONFIG_INVALID');
      expect(failure.location).toBe(`ambiguity_clarity.${field}`);
    }
  });

  it('refuses a check that is missing from it altogether', () => {
    const { safety_appropriateness: _gone, ...rest } = CONFIG;
    expect(expectError(validatePrecheckConfig(rest as never)).location).toBe('safety_appropriateness.modelVersionId');
  });

  it('refuses two checks sharing a prompt version — one check in two costumes', () => {
    const shared = { ...CONFIG, distractor_validity: { ...CONFIG.distractor_validity, promptVersionId: CONFIG.answer_verification.promptVersionId } };
    const failure = expectError(validatePrecheckConfig(shared));
    expect(failure.code).toBe('PRECHECK_PROMPTS_NOT_DISTINCT');
    expect(failure.message).toContain('answer_verification');
    expect(failure.message).toContain('distractor_validity');
  });

  it('allows two checks to share a model, which is only a registry row', () => {
    const sameModel = { ...CONFIG, distractor_validity: { ...CONFIG.distractor_validity, modelVersionId: CONFIG.answer_verification.modelVersionId } };
    expectValue(validatePrecheckConfig(sameModel));
  });
});
