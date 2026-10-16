import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, versionId } from '../../../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import { KEY_BEARING_FIELDS } from '../../../../fitness/content-rules.js';
import { RecordedProvider } from '../../infrastructure/provider/recorded-provider.js';
import { err, ok } from '../../domain/result.js';
import type { GenerationCandidate } from '../../domain/generation-candidate.js';
import { applicationError } from '../authorization.js';
import type { JudgementProvider, JudgementRequest } from '../ports.js';
import { SOLVE_COUNT, answerVerificationCheck } from './verification-check.js';

const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), '../../infrastructure/provider/recordings');
const CONFIG = { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20) };
const machine = contextFor(principalWith(['generation_pipeline'], 'system'));

const proposalBody = (name: string) => (JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
const candidateFor = (name: string, body = proposalBody(name)): GenerationCandidate => aCandidate(aRun({ promptVersionId: versionId('prompt', 7) }), { body });

/** The real recorded adapter, wrapped only to remember what it was asked. */
function observed(): { judge: JudgementProvider; asked: JudgementRequest[] } {
  const real = RecordedProvider.fromDirectory(RECORDINGS);
  const asked: JudgementRequest[] = [];
  return { asked, judge: { judge: (request) => (asked.push(request), real.judge(request)) } };
}

const check = (judge: JudgementProvider) => answerVerificationCheck({ judge, config: CONFIG });

describe('check 3 — independent answer verification', () => {
  it('is the blocking check named answer_verification, taking two solves', () => {
    expect(check(observed().judge).check).toBe('answer_verification');
    expect(SOLVE_COUNT).toBe(2);
  });

  it('passes when two independent solves agree with each other and with the claimed key, recording the working', async () => {
    const { judge } = observed();
    const outcome = expectValue(await check(judge).run(candidateFor('kinematics-ramp.json'), machine));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toContain('solve 1 answered "b"');
    expect(outcome.detail).toContain('solve 2 answered "b"');
    expect(outcome.detail).toContain('claims "b"');
  });

  it('fails when the solves disagree, with both answers recorded — and does not escalate: it is simply a failing verdict', async () => {
    const outcome = expectValue(await check(observed().judge).run(candidateFor('optics-lens.json'), machine));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toContain('solve 1 answered "c"');
    expect(outcome.detail).toContain('solve 2 answered "a"');
    expect(outcome.detail).toContain('disagree');
  });

  it('fails when the solves agree with each other but not with the claimed key', async () => {
    const body = proposalBody('kinematics-ramp.json');
    const wrongKey = { ...body, responseSpec: { ...(body['responseSpec'] as object), correctOptionId: 'd' } };
    const outcome = expectValue(await check(observed().judge).run(candidateFor('kinematics-ramp.json', wrongKey), machine));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toContain('agree with each other and not with the claimed key');
    expect(outcome.detail).toContain('claims "d"');
  });

  describe('the verifier never sees the claimed key — asserted on what it was actually sent', () => {
    it('across both solves: no key-bearing field at any depth, and not the key’s value as a field', async () => {
      const { judge, asked } = observed();
      expectValue(await check(judge).run(candidateFor('kinematics-ramp.json'), machine));

      expect(asked).toHaveLength(SOLVE_COUNT);
      const everyKey = (value: unknown): string[] =>
        Array.isArray(value) ? value.flatMap(everyKey) : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([k, v]) => [k, ...everyKey(v)]) : [];
      for (const request of asked) {
        const keys = everyKey(request);
        for (const forbidden of [...KEY_BEARING_FIELDS, 'correctOptionIds', 'responseSpec']) expect(keys, forbidden).not.toContain(forbidden);
      }
    });

    it('sends exactly the question: the stem and the options, and which solve this is', async () => {
      const { judge, asked } = observed();
      expectValue(await check(judge).run(candidateFor('kinematics-ramp.json'), machine));
      expect(asked.map((request) => Object.keys(request.input).sort())).toEqual([
        ['attempt', 'itemType', 'options', 'stem'],
        ['attempt', 'itemType', 'options', 'stem'],
      ]);
      expect(asked.map((request) => request.input['attempt'])).toEqual([1, 2]);
    });

    it('so two proposals differing only in their key send the verifier the same question', async () => {
      const body = proposalBody('kinematics-ramp.json');
      const rekeyed = { ...body, responseSpec: { ...(body['responseSpec'] as object), correctOptionId: 'c' } };
      const first = observed();
      const second = observed();
      expectValue(await check(first.judge).run(candidateFor('kinematics-ramp.json'), machine));
      expectValue(await check(second.judge).run(candidateFor('kinematics-ramp.json', rekeyed), machine));
      expect(JSON.stringify(second.asked)).toBe(JSON.stringify(first.asked));
    });
  });

  describe('F29 — the verification runs under a prompt version distinct from generation’s', () => {
    it('sends every solve under the configured verification prompt, which is not the candidate’s', async () => {
      const { judge, asked } = observed();
      const candidate = candidateFor('kinematics-ramp.json');
      expectValue(await check(judge).run(candidate, machine));
      for (const request of asked) {
        expect(request.promptVersionId).toBe(CONFIG.promptVersionId);
        expect(request.promptVersionId).not.toBe(candidate.pin.promptVersionId);
      }
    });

    // The planted violation: the candidate was generated under the very prompt
    // the verification is configured with.
    it('is red when it would reuse the candidate’s generation prompt, before the provider is asked', async () => {
      const { judge, asked } = observed();
      const generatedUnderTheSamePrompt = aCandidate(aRun({ promptVersionId: CONFIG.promptVersionId }), { body: proposalBody('kinematics-ramp.json') });
      const result = await check(judge).run(generatedUnderTheSamePrompt, machine);
      expect(expectError(result).code).toBe('CHECK_REUSES_GENERATION_PROMPT');
      expect(asked).toEqual([]);
    });
  });

  describe('cannot run — records nothing — when', () => {
    it('the item type has no independent solve defined', async () => {
      const candidate = aCandidate(aRun(), { body: proposalBody('kinematics-ramp.json'), itemType: 'MATCHING' });
      const failure = expectError(await check(observed().judge).run(candidate, machine));
      expect(failure.code).toBe('ITEM_TYPE_NOT_VERIFIABLE');
      expect(failure.location).toBe('content.itemType');
    });

    it('the proposal’s key or question cannot be read', async () => {
      const { responseSpec: _gone, ...noSpec } = proposalBody('kinematics-ramp.json');
      expect(expectError(await check(observed().judge).run(candidateFor('x', noSpec), machine)).code).toBe('PROPOSAL_UNREADABLE');
      const body = proposalBody('kinematics-ramp.json');
      const { correctOptionId: _key, ...keyless } = body['responseSpec'] as Record<string, unknown>;
      expect(expectError(await check(observed().judge).run(candidateFor('x', { ...body, responseSpec: keyless }), machine)).code).toBe('PROPOSAL_UNREADABLE');
    });

    it('the key reads but the question does not: there is nothing to put to a solver', async () => {
      const body = proposalBody('kinematics-ramp.json');
      const optionless = { ...body, responseSpec: { itemType: 'SINGLE_CORRECT_MCQ', correctOptionId: 'b' } };
      const { judge, asked } = observed();
      expect(expectError(await check(judge).run(candidateFor('x', optionless), machine)).location).toBe('content.body.responseSpec.options');
      expect(asked).toEqual([]);
    });

    it('there is no recording for the question: it fails loudly, it does not guess', async () => {
      const body = proposalBody('kinematics-ramp.json');
      const failure = expectError(await check(observed().judge).run(candidateFor('x', { ...body, stem: 'a question nobody recorded' }), machine));
      expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
    });

    it('the provider fails, or answers with nothing usable', async () => {
      const down = applicationError('Unavailable', 'PROVIDER_DOWN', 'later');
      expect(expectError(await check({ judge: async () => err(down) }).run(candidateFor('kinematics-ramp.json'), machine))).toBe(down);

      const malformed = await check({ judge: async () => ok({ output: { answer: '' } }) }).run(candidateFor('kinematics-ramp.json'), machine);
      expect(expectError(malformed).code).toBe('PROVIDER_REPLY_MALFORMED');
      const second = expectError(
        await check({ judge: (() => { let n = 0; return async () => ok({ output: n++ === 0 ? { answer: 'b' } : {} }); })() }).run(candidateFor('kinematics-ramp.json'), machine),
      );
      expect(second.location).toBe('solve 2');
    });
  });

  it('verifies a numeric and a multiple-answer item, in the same canonical form', async () => {
    const numeric = { stem: 'q', responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '9.81' } } };
    const numericCandidate = aCandidate(aRun(), { body: numeric, itemType: 'NUMERIC' });
    const answering = (answer: unknown): JudgementProvider => ({ judge: async () => ok({ output: { answer } }) });
    expect(expectValue(await check(answering(9.81)).run(numericCandidate, machine)).outcome).toBe('pass');
    expect(expectValue(await check(answering('9.80')).run(numericCandidate, machine)).outcome).toBe('fail');

    const multi = { stem: 'q', responseSpec: { itemType: 'MULTIPLE_CORRECT_MCQ', options: [], correctOptionIds: ['b', 'a'] } };
    const multiCandidate = aCandidate(aRun(), { body: multi, itemType: 'MULTIPLE_CORRECT_MCQ' });
    expect(expectValue(await check(answering(['a', 'b'])).run(multiCandidate, machine)).outcome).toBe('pass');
    expect(expectValue(await check(answering(['a'])).run(multiCandidate, machine)).outcome).toBe('fail');
  });
});
