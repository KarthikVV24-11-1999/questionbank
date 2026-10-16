import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError } from '../../../testing/expect-result.js';
import { PostgresGenerationCandidateRepository } from './generation-candidate.repository.js';
import { PostgresGenerationRunRepository } from './generation-run.repository.js';

/**
 * Stored data is untrusted: a repository rebuilds an aggregate through the
 * domain's own validation and refuses what the domain would not have built.
 *
 * The schema's CHECKs make such a row impossible to write, so the only way to
 * prove the refusal is to remove the CHECK for the duration. That is why these
 * live in a file of their own, run against the throwaway database every
 * integration spec uses and reverted at the end.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('a run whose stored pin is no longer complete', () => {
  it('is refused rather than rebuilt', async () => {
    await database.pool.query(`ALTER TABLE ai.generation_run DROP CONSTRAINT generation_run_model_version_id_check`);
    const runId = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request)
       VALUES ($1, ' ', 'prompt-v7', now(), '{}')`,
      [runId],
    );

    const failure = expectError(await new PostgresGenerationRunRepository(database.pool).findById(runId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('MODEL_VERSION_ID_REQUIRED');
    expect(failure.location).toBe('modelVersionId');
  });
});

describe('a candidate carrying a verdict for a check the battery does not have', () => {
  it('is refused rather than rebuilt, by every way of finding it', async () => {
    await database.pool.query(`ALTER TABLE ai.candidate_verdict DROP CONSTRAINT candidate_verdict_check_id_check`);
    const runId = randomUUID();
    const candidateId = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request)
       VALUES ($1, 'model-v3', 'prompt-v7', now(), '{}')`,
      [runId],
    );
    await database.pool.query(
      `INSERT INTO ai.generation_candidate (candidate_id, run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, $2, 'model-v3', 'prompt-v7', 'X', '{}', 0.5)`,
      [candidateId, runId],
    );
    await database.pool.query(
      `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, ordinal) VALUES ($1, 'grounding', 'pass', 0)`,
      [candidateId],
    );

    const repository = new PostgresGenerationCandidateRepository(database.pool);
    const failure = expectError(await repository.findById(candidateId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('VERDICT_CHECK_UNKNOWN');
    expect(failure.message).toContain(candidateId);
    expect(failure.location).toBe('verdicts[0].check');
    expect(expectError(await repository.findByRun(runId)).code).toBe('PERSISTENCE_REJECTED');
  });
});
