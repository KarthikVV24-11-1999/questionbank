import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError } from '../../../testing/expect-result.js';
import { ensureVersions, MODEL_VERSION, PROMPT_VERSION } from '../../../testing/generation-fixtures.js';
import { PostgresGenerationCandidateRepository } from './generation-candidate.repository.js';
import { PostgresVersionRegistry } from './version-registry.repository.js';
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

describe('a run whose stored request is no longer a document', () => {
  it('is refused rather than rebuilt', async () => {
    await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
    await database.pool.query(`ALTER TABLE ai.generation_run DROP CONSTRAINT generation_run_request_check`);
    const runId = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request)
       VALUES ($1, $2, $3, now(), '[1]')`,
      [runId, MODEL_VERSION, PROMPT_VERSION],
    );

    const failure = expectError(await new PostgresGenerationRunRepository(database.pool).findById(runId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('RUN_REQUEST_INVALID');
    expect(failure.location).toBe('request');
  });
});

describe('a candidate carrying a verdict for a check the battery does not have', () => {
  it('is refused rather than rebuilt, by every way of finding it', async () => {
    await database.pool.query(`ALTER TABLE ai.candidate_verdict DROP CONSTRAINT candidate_verdict_check_id_check`);
    await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
    const runId = randomUUID();
    const candidateId = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request)
       VALUES ($1, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', now(), '{}')`,
      [runId],
    );
    await database.pool.query(
      `INSERT INTO ai.generation_candidate (candidate_id, run_id, model_version_id, prompt_version_id, item_type, body, confidence)
       VALUES ($1, $2, '00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000b0007', 'X', '{}', 0.5)`,
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

describe('a registry row that no longer satisfies the domain', () => {
  it('a model version that stopped prohibiting upgrades is refused, not rebuilt', async () => {
    await database.pool.query(`ALTER TABLE ai.model_version DROP CONSTRAINT model_version_automatic_upgrades_prohibited_check`);
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.model_version (model_version_id, provider_model_id, automatic_upgrades_prohibited) VALUES ($1, $2, false)`,
      [id, `m-${id}`],
    );
    const failure = expectError(await new PostgresVersionRegistry(database.pool).findModelVersion(id));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('AUTOMATIC_UPGRADES_MUST_BE_PROHIBITED');
    expect(failure.location).toBe('automaticUpgradesProhibited');
  });

  it('a prompt version with a malformed digest is refused, not rebuilt', async () => {
    await database.pool.query(`ALTER TABLE ai.prompt_version DROP CONSTRAINT prompt_version_content_sha256_check`);
    const id = randomUUID();
    await database.pool.query(`INSERT INTO ai.prompt_version (prompt_version_id, source_file, content_sha256) VALUES ($1, $2, 'nope')`, [
      id,
      `p-${id}.md`,
    ]);
    const failure = expectError(await new PostgresVersionRegistry(database.pool).findPromptVersion(id));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('CONTENT_SHA256_INVALID');
    expect(failure.location).toBe('contentSha256');
  });
});
