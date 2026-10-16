import { randomUUID } from 'node:crypto';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { registering } from '../../../../testing/generation-fixtures.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import {
  FIXED_NOW,
  RecordingAudit,
  contextFor,
  fixedClock,
  principalWith,
} from '../../../../testing/generation-context.js';
import { createGenerationRun } from '../../domain/generation-run.js';
import { StartGenerationRunHandler } from './run-handlers.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let runs: GenerationRunRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const pipeline = principalWith(['generation_pipeline'], 'system');
const ops = principalWith(['content_ops']);
const COMMAND = {
  modelVersionId: '00000000-0000-4000-8000-0000000a0003',
  promptVersionId: '00000000-0000-4000-8000-0000000b0007',
  request: { band: 'medium', count: 5, filters: { topics: ['kinematics'] } },
};

function handler(overrides: { next?: () => string } = {}) {
  const audit = new RecordingAudit();
  return {
    audit,
    handler: new StartGenerationRunHandler({
      runs,
      clock: fixedClock,
      identifiers: { next: overrides.next ?? (() => randomUUID()) },
      audit,
    }),
  };
}

describe('StartGenerationRun', () => {
  it('persists a run that is readable, field by field', async () => {
    const { handler: start } = handler();
    const started = expectValue(await start.handle(COMMAND, contextFor(pipeline)));

    const stored = expectValue(await runs.findById(started.pin.runId));
    expect(stored.pin.runId).toBe(started.pin.runId);
    expect(stored.pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(stored.pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(stored.requestedAt).toBe(FIXED_NOW.toISOString());
    expect(stored.request['band']).toBe('medium');
    expect(stored.request['count']).toBe(5);
    expect((stored.request['filters'] as { topics: string[] }).topics).toEqual(['kinematics']);
  });

  // Pinned data, never a constant: two runs under different versions each keep
  // exactly the pin they were started with.
  it('records the pin each run was started with, whatever the versions are', async () => {
    const { handler: start } = handler();
    const pins = [
      ['00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000b0001'],
      ['00000000-0000-4000-8000-0000000a0004', '00000000-0000-4000-8000-0000000b0009'],
    ] as const;
    for (const [modelVersionId, promptVersionId] of pins) {
      const started = expectValue(await start.handle({ ...COMMAND, modelVersionId, promptVersionId }, contextFor(pipeline)));
      const stored = expectValue(await runs.findById(started.pin.runId));
      expect(stored.pin.modelVersionId).toBe(modelVersionId);
      expect(stored.pin.promptVersionId).toBe(promptVersionId);
    }
  });

  it('takes the run id and the time from its own ports, not from the caller', async () => {
    const id = randomUUID();
    const { handler: start } = handler({ next: () => id });
    const started = expectValue(await start.handle(COMMAND, contextFor(ops)));
    expect(started.pin.runId).toBe(id);
    expect(started.requestedAt).toBe('2026-10-16T09:30:00.000Z');
  });

  it('audits the act under the caller’s principal and correlation id, naming the run and nothing of the request', async () => {
    const { handler: start, audit } = handler();
    const context = contextFor(pipeline, 'corr-00000000-0000-4000-8000-0000000c0001');
    const started = expectValue(await start.handle(COMMAND, context));

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.action).toBe('StartGenerationRun');
    expect(entry.targetContext).toBe('generation');
    expect(entry.targetType).toBe('GenerationRun');
    expect(entry.targetId).toBe(started.pin.runId);
    expect(entry.principal).toBe(pipeline);
    expect(entry.correlationId).toBe('corr-00000000-0000-4000-8000-0000000c0001');
    expect(entry.occurredAt).toBe(FIXED_NOW);
    expect(JSON.stringify(entry)).not.toContain('kinematics');
  });

  describe('refuses, writing and auditing nothing', () => {
    async function untouched(act: () => Promise<unknown>): Promise<void> {
      const before = (await database.pool.query('SELECT count(*)::int AS n FROM ai.generation_run')).rows[0].n as number;
      await act();
      const after = (await database.pool.query('SELECT count(*)::int AS n FROM ai.generation_run')).rows[0].n as number;
      expect(after).toBe(before);
    }

    it('a principal holding neither role', async () => {
      const { handler: start, audit } = handler();
      await untouched(async () => {
        expect(expectError(await start.handle(COMMAND, contextFor(principalWith(['author', 'reviewer'])))).code).toBe('NOT_PERMITTED');
      });
      expect(audit.entries).toEqual([]);
    });

    it('a missing model or prompt version, naming which', async () => {
      const { handler: start, audit } = handler();
      await untouched(async () => {
        for (const field of ['modelVersionId', 'promptVersionId'] as const) {
          const failure = expectError(await start.handle({ ...COMMAND, [field]: '  ' }, contextFor(pipeline)));
          expect(failure.kind).toBe('Validation');
          expect(failure.location).toBe(field);
        }
      });
      expect(audit.entries).toEqual([]);
    });

    it('a request that is not a JSON object', async () => {
      const { handler: start } = handler();
      const failure = expectError(await start.handle({ ...COMMAND, request: [] as never }, contextFor(pipeline)));
      expect(failure.code).toBe('RUN_REQUEST_INVALID');
      expect(failure.location).toBe('request');
    });

    it('an identifier the store already holds, as a Conflict', async () => {
      const id = randomUUID();
      const { handler: start } = handler({ next: () => id });
      expectValue(await start.handle(COMMAND, contextFor(pipeline)));
      const { handler: again, audit } = handler({ next: () => id });
      const failure = expectError(await again.handle({ ...COMMAND, promptVersionId: '00000000-0000-4000-8000-0000000b0008' }, contextFor(pipeline)));
      expect(failure.kind).toBe('Conflict');
      expect(audit.entries).toEqual([]);
      expect(expectValue(await runs.findById(id)).pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    });
  });

  // "Its pin cannot be changed afterwards": three independent ways to try, each
  // refused by a different layer.
  describe('the pin cannot be changed afterwards', () => {
    async function started() {
      const { handler: start } = handler();
      return expectValue(await start.handle(COMMAND, contextFor(pipeline)));
    }

    it('not by saving the run again with a different pin', async () => {
      const run = await started();
      const rewritten = expectValue(
        createGenerationRun({
          pin: { ...run.pin, promptVersionId: '00000000-0000-4000-8000-0000000b0099' },
          requestedAt: run.requestedAt,
          request: run.request,
        }),
      );
      expect(expectError(await runs.save(rewritten)).kind).toBe('Conflict');
      expect(expectValue(await runs.findById(run.pin.runId)).pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    });

    it('not by an UPDATE, which the table refuses from every role', async () => {
      const run = await started();
      await expect(
        database.pool.query(`UPDATE ai.generation_run SET prompt_version_id = '00000000-0000-4000-8000-0000000b0099' WHERE run_id = $1`, [run.pin.runId]),
      ).rejects.toThrow(/append-only/u);
      expect(expectValue(await runs.findById(run.pin.runId)).pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    });

    it('not by the application role, which holds no UPDATE', async () => {
      const run = await started();
      const client = await database.pool.connect();
      try {
        await client.query('SET ROLE questionbank_app');
        await expect(
          client.query(`UPDATE ai.generation_run SET model_version_id = '00000000-0000-4000-8000-0000000a0099' WHERE run_id = $1`, [run.pin.runId]),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });
  });
});
