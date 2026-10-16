import { describe, expect, it } from 'vitest';
import * as generation from './index.js';
import { readCode } from '../../../fitness/source-scan.js';
import { fileURLToPath } from 'node:url';

/**
 * The generation barrel, in the shape of `content/m5-seam.spec.ts`: written
 * against `generation/public/` and nothing else, so a name that leaks across it
 * fails here rather than in whichever context first imports it.
 */
describe('the barrel exposes commands, vocabulary and events', () => {
  it('builds both commands', () => {
    const accept: generation.AcceptCandidate = { candidateId: 'c-1' };
    const reject: generation.RejectCandidate = { candidateId: 'c-1' };
    expect([accept.candidateId, reject.candidateId]).toEqual(['c-1', 'c-1']);
  });

  it('reads the closed candidate vocabulary', () => {
    const states: readonly generation.CandidateState[] = generation.CANDIDATE_STATES;
    expect([...states]).toEqual(['proposed', 'accepted', 'rejected']);
  });

  it('builds both events, each carrying the whole pin', () => {
    const pin: generation.ModelPin = { modelVersionId: 'm', promptVersionId: 'p', runId: 'r' };
    const accepted: generation.CandidateAccepted = { eventType: 'CandidateAccepted', candidateId: 'c', pin };
    const rejected: generation.GenerationEvent = { eventType: 'CandidateRejected', candidateId: 'c', pin };
    const types: readonly generation.GenerationEventType[] = generation.GENERATION_EVENT_TYPES;
    expect([...types]).toEqual([accepted.eventType, rejected.eventType]);
  });
});

describe('the barrel exports no aggregate, repository, handler or infrastructure value', () => {
  it('exports exactly these runtime names — asserted as a set, so growth is a reviewed diff', () => {
    expect(Object.keys(generation).sort()).toEqual(['CANDIDATE_STATES', 'GENERATION_EVENT_TYPES']);
  });

  it('exports none of the names that would hand a consumer the aggregate', () => {
    const forbidden = [
      'createGenerationCandidate',
      'acceptCandidate',
      'rejectCandidate',
      'applyCandidateTransition',
      'createModelPin',
      'PostgresGenerationCandidateRepository',
      'GenerationCandidateRepository',
      'AcceptCandidateHandler',
      'RejectCandidateHandler',
      'generationSchema',
    ];
    for (const name of forbidden) {
      expect(Object.keys(generation), name).not.toContain(name);
    }
  });

  it('has a source that re-exports types and the two vocabularies, and nothing from a handler or repository', () => {
    const source = readCode(fileURLToPath(new URL('./index.ts', import.meta.url)));
    expect(source).not.toMatch(/\/infrastructure\//u);
    expect(source).not.toMatch(/\/api\//u);
    expect(source).not.toMatch(/handlers?\//u);
    expect(source).not.toMatch(/export \{[^}]*(create|accept|reject|apply)\w*/u);
  });
});
