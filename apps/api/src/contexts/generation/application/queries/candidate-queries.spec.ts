import { describe, expect, it } from 'vitest';
import { err, ok } from '../../domain/result.js';
import { createGenerationCandidate, type GenerationCandidate } from '../../domain/generation-candidate.js';
import { BLOCKING_PRECHECKS } from '../../domain/precheck-vocabulary.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import { GetCandidateHandler, ListRunCandidatesHandler } from './candidate-queries.js';

const PIN = { modelVersionId: '00000000-0000-4000-8000-0000000a0003', promptVersionId: '00000000-0000-4000-8000-0000000b0007', runId: '00000000-0000-4000-8000-0000000c0042' };

const candidate = (id: string, verdicts: GenerationCandidate['verdicts']): GenerationCandidate =>
  expectValue(createGenerationCandidate({ candidateId: id, pin: PIN, content: { itemType: 'SINGLE_CORRECT_MCQ', body: { stem: 's' } }, confidence: 0.8, verdicts }));

const passing = candidate('passes', BLOCKING_PRECHECKS.map((check) => ({ check, outcome: 'pass' as const })));
const failedBlocking = candidate('failed-blocking', BLOCKING_PRECHECKS.map((check) => ({ check, outcome: check === 'answer_verification' ? ('fail' as const) : ('pass' as const) })));
const failedAdvisory = candidate('failed-advisory', [{ check: 'duplicate_detection', outcome: 'fail' }]);
const unchecked = candidate('unchecked', []);

function repository(stored: readonly GenerationCandidate[]): GenerationCandidateRepository {
  return {
    findByRun: async () => ok(stored),
    findById: async (id: string) => {
      const found = stored.find((entry) => entry.candidateId === id);
      return found === undefined ? err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'no such candidate' } as never) : ok(found);
    },
  } as unknown as GenerationCandidateRepository;
}

const ops = contextFor(principalWith(['content_ops']));

describe('listing a run’s candidates leaves out the ones that failed a blocking check (M5-39)', () => {
  const list = new ListRunCandidatesHandler({ candidates: repository([passing, failedBlocking, failedAdvisory, unchecked]) });

  it('keeps those a person can still decide about: passed, failed only an advisory check, or not yet checked', async () => {
    const listed = expectValue(await list.handle({ runId: PIN.runId }, ops));
    expect(listed.map((entry) => entry.candidateId)).toEqual(['passes', 'failed-advisory', 'unchecked']);
  });

  it('leaves out the one that failed a blocking check — and only that one', async () => {
    const listed = expectValue(await list.handle({ runId: PIN.runId }, ops));
    expect(listed.map((entry) => entry.candidateId)).not.toContain('failed-blocking');
    expect(listed).toHaveLength(3);
  });

  it('is still refused to the machine, and still surfaces a store refusal', async () => {
    expect(expectError(await list.handle({ runId: PIN.runId }, contextFor(principalWith(['generation_pipeline'])))).code).toBe('NOT_PERMITTED');
    const broken = new ListRunCandidatesHandler({
      candidates: { findByRun: async () => err({ kind: 'Unavailable', code: 'X', message: 'x' }) } as unknown as GenerationCandidateRepository,
    });
    expect(expectError(await broken.handle({ runId: PIN.runId }, ops)).kind).toBe('Unavailable');
  });
});

describe('reading one candidate by id is not filtered: the failing verdicts and their working stay readable', () => {
  it('returns the candidate that failed a blocking check', async () => {
    const get = new GetCandidateHandler({ candidates: repository([failedBlocking]) });
    const found = expectValue(await get.handle({ candidateId: 'failed-blocking' }, ops));
    expect(found.verdicts.some((verdict) => verdict.check === 'answer_verification' && verdict.outcome === 'fail')).toBe(true);
  });
});
