import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, versionId } from '../../../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import { RecordedProvider } from '../../infrastructure/provider/recorded-provider.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { JudgementProvider, JudgementRequest } from '../ports.js';
import { PRECHECKS } from '../../domain/precheck-vocabulary.js';
import { judgementCheck, type JudgementCheckId } from './judgement-checks.js';

const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), '../../infrastructure/provider/recordings');
const machine = contextFor(principalWith(['generation_pipeline'], 'system'));
const PROMPT: Record<JudgementCheckId, number> = { item_solution_key_consistency: 21, distractor_validity: 22, ambiguity_clarity: 23, safety_appropriateness: 24 };
const configFor = (check: JudgementCheckId) => ({ modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', PROMPT[check]) });

const bodyOf = (name: string) => (JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
const rationaleOf = (name: string) => (JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as { response: { output: { rationale: string } } }).response.output.rationale;
const candidateFor = (body: Record<string, unknown>, itemType = 'SINGLE_CORRECT_MCQ') =>
  aCandidate(aRun({ promptVersionId: versionId('prompt', 7) }), { body, itemType });

function observed(): { judge: JudgementProvider; asked: JudgementRequest[] } {
  const real = RecordedProvider.fromDirectory(RECORDINGS);
  const asked: JudgementRequest[] = [];
  return { asked, judge: { judge: (request) => (asked.push(request), real.judge(request)) } };
}
const check = (id: JudgementCheckId, judge: JudgementProvider) => judgementCheck(id, { judge, config: configFor(id) });
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

const RAMP = bodyOf('kinematics-ramp.json');
const LENS = bodyOf('optics-lens.json');

describe.each([
  ['item_solution_key_consistency', 'consistency-kinematics-ramp.json', 6],
  ['distractor_validity', 'distractors-kinematics-ramp.json', 7],
  ['ambiguity_clarity', 'ambiguity-kinematics-ramp.json', 10],
  ['safety_appropriateness', 'safety-kinematics-ramp.json', 11],
] as const)('%s — recording %s (check %i)', (id, recording, number) => {
  it('is the vocabulary’s check, one interaction under its own prompt version', async () => {
    expect(PRECHECKS.find((entry) => entry.id === id)?.number).toBe(number);
    const { judge, asked } = observed();
    expectValue(await check(id, judge).run(candidateFor(RAMP), machine));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.promptVersionId).toBe(configFor(id).promptVersionId);
    expect(asked[0]?.modelVersionId).toBe(configFor(id).modelVersionId);
  });

  it('records the working as the verdict’s detail, so a reviewer sees why and not only what', async () => {
    const outcome = expectValue(await check(id, observed().judge).run(candidateFor(RAMP), machine));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toBe(rationaleOf(recording));
    expect((outcome.detail ?? '').length).toBeGreaterThan(30);
  });

  it('is red when its prompt would be the one the candidate was generated with (F29), before the provider is asked', async () => {
    const { judge, asked } = observed();
    const sameGeneration = aCandidate(aRun({ promptVersionId: configFor(id).promptVersionId }), { body: RAMP });
    expect(expectError(await check(id, judge).run(sameGeneration, machine)).code).toBe('CHECK_REUSES_GENERATION_PROMPT');
    expect(asked).toEqual([]);
  });

  it('fails loudly for a proposal nobody recorded, rather than guessing', async () => {
    const failure = expectError(await check(id, observed().judge).run(candidateFor({ ...RAMP, stem: 'unrecorded' }), machine));
    expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
  });

  it('cannot run on a reply with no usable verdict and rationale', async () => {
    for (const output of [{}, { outcome: 'maybe', rationale: 'x' }, { outcome: 'pass' }, { outcome: 'pass', rationale: '  ' }, { outcome: 'pass', rationale: 4 }]) {
      const failure = expectError(await check(id, { judge: async () => ok({ output }) }).run(candidateFor(RAMP), machine));
      expect(failure.code).toBe('PROVIDER_REPLY_MALFORMED');
    }
  });

  it('returns the provider’s own failure unchanged', async () => {
    const down = applicationError('Unavailable', 'PROVIDER_DOWN', 'later');
    expect(expectError(await check(id, { judge: async () => err(down) }).run(candidateFor(RAMP), machine))).toBe(down);
  });

  it('trims the rationale it records', async () => {
    const outcome = expectValue(await check(id, { judge: async () => ok({ output: { outcome: 'fail', rationale: '  padded  ' } }) }).run(candidateFor(RAMP), machine));
    expect(outcome).toEqual({ outcome: 'fail', detail: 'padded' });
  });
});

describe('a check records what the model said, including when it says no', () => {
  it('an ambiguous stem fails check 10 with the model’s reasoning', async () => {
    const outcome = expectValue(await check('ambiguity_clarity', observed().judge).run(candidateFor(LENS), machine));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toBe(rationaleOf('ambiguity-optics-lens.json'));
    expect(outcome.detail).toContain('could defend two options');
  });
});

describe('each check is shown what its question needs, and no more', () => {
  async function sent(id: JudgementCheckId, body = RAMP): Promise<Record<string, unknown>> {
    const { judge, asked } = observed();
    await check(id, judge).run(candidateFor(body), machine);
    return asked[0]!.input as Record<string, unknown>;
  }

  it('consistency sees the item, its key and its solution — that is the question', async () => {
    expect(Object.keys(await sent('item_solution_key_consistency')).sort()).toEqual(['itemType', 'responseSpec', 'solution', 'stem']);
  });

  it('distractor validity sees the item and its key, not the solution', async () => {
    expect(Object.keys(await sent('distractor_validity')).sort()).toEqual(['itemType', 'responseSpec', 'stem']);
  });

  it('ambiguity and safety see what a learner reads — never the key', async () => {
    for (const id of ['ambiguity_clarity', 'safety_appropriateness'] as const) {
      const input = await sent(id);
      const keys = keysOf(input);
      expect(keys, id).not.toContain('correctOptionId');
      expect(keys, id).not.toContain('responseSpec');
      expect(Object.keys(input)).toEqual(expect.arrayContaining(['itemType', 'stem', 'options']));
    }
  });

  it('safety also reads the solution a learner will be shown', async () => {
    expect(Object.keys(await sent('safety_appropriateness'))).toContain('solution');
  });

  it('each check runs under a prompt version of its own', async () => {
    const prompts = new Set<string>();
    for (const id of Object.keys(PROMPT) as JudgementCheckId[]) {
      const { judge, asked } = observed();
      await check(id, judge).run(candidateFor(RAMP), machine);
      prompts.add(asked[0]!.promptVersionId);
    }
    expect(prompts.size).toBe(4);
  });
});

describe('cannot run — records nothing — when the proposal lacks what the question needs', () => {
  it('consistency, with no solution to check against: the proposal is unreadable for this purpose', async () => {
    const failure = expectError(await check('item_solution_key_consistency', observed().judge).run(candidateFor(LENS), machine));
    expect(failure.code).toBe('PROPOSAL_UNREADABLE');
    expect(failure.location).toBe('content.body.solution');
  });

  it('consistency and distractors, with no specification', async () => {
    const { responseSpec: _gone, ...bare } = RAMP;
    for (const id of ['item_solution_key_consistency', 'distractor_validity'] as const) {
      expect(expectError(await check(id, observed().judge).run(candidateFor(bare), machine)).location).toBe('content.body.responseSpec');
    }
    const { stem: _stem, ...noStem } = RAMP;
    expect(expectError(await check('distractor_validity', observed().judge).run(candidateFor(noStem), machine)).code).toBe('PROPOSAL_UNREADABLE');
    expect(expectError(await check('item_solution_key_consistency', observed().judge).run(candidateFor(noStem), machine)).code).toBe('PROPOSAL_UNREADABLE');
  });

  it('ambiguity and safety, with no stem', async () => {
    const { stem: _stem, ...noStem } = RAMP;
    for (const id of ['ambiguity_clarity', 'safety_appropriateness'] as const) {
      expect(expectError(await check(id, observed().judge).run(candidateFor(noStem), machine)).location).toBe('content.body.stem');
    }
  });
});

describe('what an item without options is shown', () => {
  const numeric = { stem: 'What is g?', responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '9.81' } } };

  it('ambiguity and safety are asked about the stem alone', async () => {
    for (const id of ['ambiguity_clarity', 'safety_appropriateness'] as const) {
      const asked: JudgementRequest[] = [];
      const judge: JudgementProvider = { judge: async (request) => (asked.push(request), ok({ output: { outcome: 'pass', rationale: 'fine' } })) };
      expectValue(await check(id, judge).run(candidateFor(numeric, 'NUMERIC'), machine));
      expect(Object.keys(asked[0]!.input).sort()).toEqual(['itemType', 'stem']);
    }
  });

  it('and are not misled by a specification that is missing or has options that are not options', async () => {
    for (const body of [{ stem: 'only a stem' }, { stem: 's', responseSpec: { options: [1, 2] } }, { stem: 's', responseSpec: 'nonsense' }]) {
      const asked: JudgementRequest[] = [];
      const judge: JudgementProvider = { judge: async (request) => (asked.push(request), ok({ output: { outcome: 'pass', rationale: 'fine' } })) };
      expectValue(await check('ambiguity_clarity', judge).run(candidateFor(body), machine));
      expect(Object.keys(asked[0]!.input).sort()).toEqual(['itemType', 'stem']);
    }
  });

  it('distractor validity passes a numeric item as not applicable, without consulting a model, and says so', async () => {
    const { judge, asked } = observed();
    const outcome = expectValue(await check('distractor_validity', judge).run(candidateFor(numeric, 'NUMERIC'), machine));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toContain('not applicable');
    expect(asked).toEqual([]);
  });

  it('but still asks about a multiple-answer item, which does have distractors', async () => {
    const asked: JudgementRequest[] = [];
    const judge: JudgementProvider = { judge: async (request) => (asked.push(request), ok({ output: { outcome: 'pass', rationale: 'ok' } })) };
    expectValue(await check('distractor_validity', judge).run(candidateFor(RAMP, 'MULTIPLE_CORRECT_MCQ'), machine));
    expect(asked).toHaveLength(1);
  });
});
