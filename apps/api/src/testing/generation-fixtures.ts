import { randomUUID } from 'node:crypto';
import { createGenerationCandidate, type GenerationCandidate } from '../contexts/generation/domain/generation-candidate.js';
import { createGenerationRun, type GenerationRun } from '../contexts/generation/domain/generation-run.js';
import type { CandidateAccepted, CandidateRejected } from '../contexts/generation/domain/events/generation-events.js';
import { expectValue } from './expect-result.js';

export const MODEL_VERSION = 'model-v3';
export const PROMPT_VERSION = 'prompt-v7';

/** A run with fresh identifiers, so specs never depend on each other's rows. */
export function aRun(overrides: { modelVersionId?: string; promptVersionId?: string; request?: Record<string, unknown> } = {}): GenerationRun {
  return expectValue(
    createGenerationRun({
      pin: {
        modelVersionId: overrides.modelVersionId ?? MODEL_VERSION,
        promptVersionId: overrides.promptVersionId ?? PROMPT_VERSION,
        runId: randomUUID(),
      },
      requestedAt: '2026-10-16T09:30:00.125Z',
      request: overrides.request ?? { band: 'medium', count: 5, filters: { topics: ['kinematics', 'optics'], strict: true } },
    }),
  );
}

/** A proposed candidate pinned to `run`, carrying a nested proposal so a lossy round trip has something to lose. */
export function aCandidate(run: GenerationRun, overrides: { body?: Record<string, unknown>; itemType?: string; confidence?: number } = {}): GenerationCandidate {
  return expectValue(
    createGenerationCandidate({
      candidateId: randomUUID(),
      pin: run.pin,
      content: {
        itemType: overrides.itemType ?? 'SINGLE_CORRECT_MCQ',
        body: overrides.body ?? {
          stem: 'A block slides down a ramp.',
          options: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }],
          meta: { difficulty: 0.4, tags: ['mechanics'], reviewed: false, note: null },
        },
      },
      verdicts: [],
      confidence: overrides.confidence ?? 0.85,
    }),
  );
}

export const PRINCIPAL = { kind: 'human', id: randomUUID() } as const;

export function acceptedEvent(candidate: GenerationCandidate, overrides: Partial<CandidateAccepted> = {}): CandidateAccepted {
  return {
    eventType: 'CandidateAccepted',
    schemaVersion: 1,
    occurredAt: '2026-10-16T10:00:00.000Z',
    principal: PRINCIPAL,
    correlationId: 'corr-1',
    candidateId: candidate.candidateId,
    pin: candidate.pin,
    contentItemId: randomUUID(),
    ...overrides,
  };
}

export function rejectedEvent(candidate: GenerationCandidate): CandidateRejected {
  const { contentItemId: _linked, ...rest } = acceptedEvent(candidate);
  return { ...rest, eventType: 'CandidateRejected' };
}
