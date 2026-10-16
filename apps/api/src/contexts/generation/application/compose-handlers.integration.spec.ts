import { randomUUID } from 'node:crypto';
import type { GenerationRunRepository } from '../domain/repository-ports.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { aCandidate, aRun, registering } from '../../../testing/generation-fixtures.js';
import { RecordingAudit, contextFor, fixedClock, principalWith, uuidFactory } from '../../../testing/generation-context.js';
import { PostgresGenerationCandidateRepository } from '../infrastructure/generation-candidate.repository.js';
import { composeGenerationHandlers } from './compose-handlers.js';
import { GENERATION_POLICIES } from './policies.js';
import type { GenerationCandidate } from '../domain/generation-candidate.js';
import type { Handler } from './handler-registry.js';

/**
 * F36 for this context, through the composed factory — the function the
 * composition root calls — against real Postgres. A list asserted against
 * itself would pass on a handler composed by a path that bypassed the registry;
 * resolving each one from the registry that was actually built, and running it,
 * would not.
 */
let database: TestDatabase;
let runs: GenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

function registry() {
  return composeGenerationHandlers({ runs, candidates, clock: fixedClock, identifiers: uuidFactory, audit: new RecordingAudit(), content: {} as never, provider: {} as never, runners: [], blocked: [] });
}

describe('every handler the context declares is registered, through the real composed factory', () => {
  it('registers a handler for every declared policy, under the policy’s own name', () => {
    const composed = registry();
    const expected = GENERATION_POLICIES.map((entry) => entry.name);

    expect([...composed.names].sort()).toEqual([...expected].sort());
    expect(expected).toHaveLength(8);
    for (const entry of GENERATION_POLICIES.filter((declared) => expected.includes(declared.name))) {
      expect(composed.get(entry.name)?.policy, entry.name).toBe(entry);
    }
  });

  it('names no policy-less handler, and no policy without a role', () => {
    const composed = registry();
    for (const name of composed.names) {
      expect(composed.get(name)?.policy.allowedRoles.length, name).toBeGreaterThan(0);
    }
  });
});

describe('the composed query handlers, executed through the registry', () => {
  const ops = principalWith(['content_ops']);
  const pipeline = principalWith(['generation_pipeline']);

  async function stored(): Promise<{ candidate: GenerationCandidate; runId: string }> {
    const run = aRun();
    expectValue(await runs.save(run));
    const candidate = aCandidate(run);
    expectValue(await candidates.save(candidate));
    return { candidate, runId: run.pin.runId };
  }

  it('GetCandidate returns a stored candidate to Content Ops', async () => {
    const { candidate } = await stored();
    const handler = registry().get<{ candidateId: string }, GenerationCandidate>('GetCandidate') as Handler<
      { candidateId: string },
      GenerationCandidate
    >;
    const found = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    expect(found.candidateId).toBe(candidate.candidateId);
    expect(found.confidence).toBe(0.85);
  });

  it('GetCandidate refuses the machine, and reports a missing candidate as NotFound', async () => {
    const { candidate } = await stored();
    const handler = registry().get<{ candidateId: string }, GenerationCandidate>('GetCandidate')!;
    expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(pipeline))).code).toBe('NOT_PERMITTED');
    const missing = expectError(await handler.handle({ candidateId: randomUUID() }, contextFor(ops)));
    expect(missing.kind).toBe('NotFound');
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('ListRunCandidates returns a run’s candidates, refuses the machine, and surfaces a store refusal', async () => {
    const { candidate, runId } = await stored();
    const handler = registry().get<{ runId: string }, readonly GenerationCandidate[]>('ListRunCandidates')!;
    const listed = expectValue(await handler.handle({ runId }, contextFor(ops)));
    expect(listed.map((entry) => entry.candidateId)).toEqual([candidate.candidateId]);
    expect(expectError(await handler.handle({ runId }, contextFor(pipeline))).code).toBe('NOT_PERMITTED');
    expect(expectError(await handler.handle({ runId: 'not-a-uuid' }, contextFor(ops))).code).toBe('PERSISTENCE_REJECTED');
  });
});
