import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { GenerationRunRepository } from '../contexts/generation/domain/repository-ports.js';
import { PostgresGenerationRunRepository } from '../contexts/generation/infrastructure/generation-run.repository.js';
import { createGenerationCandidate, type GenerationCandidate } from '../contexts/generation/domain/generation-candidate.js';
import { createGenerationRun, type GenerationRun } from '../contexts/generation/domain/generation-run.js';
import type { CandidateAccepted, CandidateRejected } from '../contexts/generation/domain/events/generation-events.js';
import { expectValue } from './expect-result.js';

/** Stable registry identifiers, so a spec can say which version it means without minting a new one each time. */
export function versionId(kind: 'model' | 'prompt' | 'run', n: number): string {
  const tag = { model: 'a', prompt: 'b', run: 'c' }[kind];
  return `00000000-0000-4000-8000-0000000${tag}${String(n).padStart(4, '0')}`;
}

export const MODEL_VERSION = versionId('model', 3);
export const PROMPT_VERSION = versionId('prompt', 7);

/**
 * Publishes a model and a prompt version into the registry if they are not there
 * yet. Versions are rows (AI-ARCHITECTURE §15), so a run naming one the registry
 * lacks is refused by the database — a spec that wants a run must first publish
 * what it pins. Idempotent, because the registry is append-only and shared by
 * every spec in a file.
 */
export async function ensureVersions(pool: Pool, pin: { modelVersionId: string; promptVersionId: string }): Promise<void> {
  await pool.query(
    `INSERT INTO ai.model_version (model_version_id, provider_model_id, automatic_upgrades_prohibited)
     VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
    [pin.modelVersionId, `provider-model-${pin.modelVersionId}`],
  );
  await pool.query(
    `INSERT INTO ai.prompt_version (prompt_version_id, source_file, content_sha256)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [pin.promptVersionId, `prompts/${pin.promptVersionId}.md`, '0'.repeat(64)],
  );
}

/** The real run repository, publishing the versions a run pins before saving it. */
export function registering(pool: Pool): GenerationRunRepository {
  const runs = new PostgresGenerationRunRepository(pool);
  return {
    save: async (run) => {
      await ensureVersions(pool, run.pin);
      return runs.save(run);
    },
    findById: (id) => runs.findById(id),
  };
}

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
