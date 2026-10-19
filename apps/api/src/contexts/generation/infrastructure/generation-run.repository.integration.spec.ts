import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, aRun, ensureVersions, registering, versionId } from '../../../testing/generation-fixtures.js';
import type { GenerationRunRepository } from '../domain/repository-ports.js';
import { PostgresGenerationRunRepository } from './generation-run.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let repository: GenerationRunRepository;
let unregistering: PostgresGenerationRunRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = registering(database.pool);
  unregistering = new PostgresGenerationRunRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('a run pins registry rows, and nothing else', () => {
  it('is refused by the database when it names a model version the registry does not hold', async () => {
    const run = aRun({ modelVersionId: versionId('model', 9001) });
    const failure = expectError(await unregistering.save(run));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('version_not_evaluated');
    expect(expectError(await unregistering.findById(run.pin.runId)).kind).toBe('NotFound');
  });

  it('is refused by the database when it names a prompt version the registry does not hold', async () => {
    await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
    const run = aRun({ promptVersionId: versionId('prompt', 9001) });
    const failure = expectError(await unregistering.save(run));
    expect(failure.message).toContain('version_not_evaluated');
  });

  it('is saved once both are published', async () => {
    const run = aRun({ modelVersionId: versionId('model', 9002), promptVersionId: versionId('prompt', 9002) });
    expectError(await unregistering.save(run));
    expectValue(await repository.save(run));
    expect(expectValue(await unregistering.findById(run.pin.runId)).pin.promptVersionId).toBe(versionId('prompt', 9002));
  });
});

describe('saving and finding a run', () => {
  // Field by field against literals, never `toEqual(saved)`: an assertion of
  // one read-back shape against another passes when both are missing the same
  // field (ADR-0017).
  it('reads back every field it was given', async () => {
    const run = aRun();
    expect(expectValue(await repository.save(run)).pin.runId).toBe(run.pin.runId);

    const found = expectValue(await repository.findById(run.pin.runId));
    expect(found.pin.runId).toBe(run.pin.runId);
    expect(found.pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(found.pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(found.requestedAt).toBe('2026-10-16T09:30:00.125Z');
    expect(found.request['band']).toBe('medium');
    expect(found.request['count']).toBe(5);
    const filters = found.request['filters'] as { topics: string[]; strict: boolean };
    expect(filters.topics).toEqual(['kinematics', 'optics']);
    expect(filters.strict).toBe(true);
    expect(Object.keys(found).sort()).toEqual(['budgetTokens', 'pin', 'request', 'requestedAt']);
    expect(Object.keys(found.pin).sort()).toEqual(['modelVersionId', 'promptVersionId', 'runId']);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('stores the pin in the columns the F28 query reads', async () => {
    const run = aRun({ modelVersionId: '00000000-0000-4000-8000-0000000a0009', promptVersionId: '00000000-0000-4000-8000-0000000b0001' });
    await repository.save(run);
    const { rows } = await database.pool.query(
      `SELECT model_version_id, prompt_version_id, request_schema_version FROM ai.generation_run WHERE run_id = $1`,
      [run.pin.runId],
    );
    expect(rows).toEqual([{ model_version_id: '00000000-0000-4000-8000-0000000a0009', prompt_version_id: '00000000-0000-4000-8000-0000000b0001', request_schema_version: 1 }]);
  });

  it('reports a run saved twice as a Conflict and leaves the first untouched', async () => {
    const run = aRun();
    await repository.save(run);
    const failure = expectError(await repository.save(aRunWithId(run.pin.runId, { count: 99 })));
    expect(failure.kind).toBe('Conflict');
    expect(failure.code).toBe('CONFLICT');

    const found = expectValue(await repository.findById(run.pin.runId));
    expect(found.request['count']).toBe(5);
  });

  it('reports a run that was never saved as NotFound', async () => {
    const id = randomUUID();
    const failure = expectError(await repository.findById(id));
    expect(failure.kind).toBe('NotFound');
    expect(failure.code).toBe('NOT_FOUND');
    expect(failure.message).toContain(id);
  });

  it('reports what the store refuses as PERSISTENCE_REJECTED, without the statement', async () => {
    const failure = expectError(await repository.findById('not-a-uuid'));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).not.toContain('SELECT');

    const unsavable = aRun();
    const badId = { ...unsavable, pin: { ...unsavable.pin, runId: 'not-a-uuid' } };
    expect(expectError(await repository.save(badId)).code).toBe('PERSISTENCE_REJECTED');
  });
});

function aRunWithId(runId: string, request: Record<string, unknown>) {
  const run = aRun({ request });
  return { ...run, pin: { ...run.pin, runId } };
}

describe('enqueueing against a budget, when the store itself fails', () => {
  // A pool whose connections fail on the first statement after BEGIN, and fail again on ROLLBACK:
  // the repository must still report a value (§8), release the connection, and not mask the first failure.
  it('reports the store’s refusal as a value and releases the connection, even when the rollback fails too', async () => {
    let released = 0;
    const client = {
      query: async (statement: string) => {
        if (statement === 'BEGIN') return { rows: [] };
        throw Object.assign(new Error('connection lost'), { code: '08006' });
      },
      release: () => {
        released += 1;
      },
    };
    const failing = new PostgresGenerationRunRepository({ connect: async () => client } as never);

    const failure = expectError(await failing.saveWithinBudget(aRun(), 'generation'));

    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).not.toContain('connection lost');
    expect(released).toBe(1);
  });
});
