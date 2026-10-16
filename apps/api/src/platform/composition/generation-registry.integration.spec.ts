import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERATION_POLICIES } from '../../contexts/generation/application/policies.js';
import type { Handler, HandlerRegistry } from '../../contexts/generation/application/handler-registry.js';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import type { GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { PRECHECK_IDS } from '../../contexts/generation/domain/precheck-vocabulary.js';
import type { GenerationRunRepository } from '../../contexts/generation/domain/repository-ports.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';
import { composeGeneration, type ComposedGeneration } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { contextFor, principalWith } from '../../testing/generation-context.js';
import { MODEL_VERSION, PROMPT_VERSION, aCandidate, aRun, ensureVersions, registering } from '../../testing/generation-fixtures.js';

/**
 * Generation as the application composes it, executed against real Postgres (M5-37).
 *
 * This is F36 for the context through the function the composition root actually
 * runs: a list asserted against itself would pass on a handler composed by a path
 * that bypassed the registry, and resolving each one from the registry that was
 * built — and running it — would not. It also holds the three things that are only
 * true of the composed whole: the audit recorder in front of generation is the real
 * one and accepts its rows; a deployment given no configuration is safe rather than
 * broken; and a deployment given no provider says so rather than inventing an answer.
 */
let database: TestDatabase;
let composed: ComposedGeneration;
let registry: HandlerRegistry;
let runs: GenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  // No provider and no pre-check configuration: what a deployment that supplied neither gets.
  composed = await composeGeneration(database);
  registry = composed.registry;
  runs = registering(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
});

afterAll(async () => {
  await composed.close();
  await database.revertMigrations();
  await database.close();
});

const ops = principalWith(['content_ops']);
const pipeline = principalWith(['generation_pipeline'], 'system');

function handler<I, O>(name: string): Handler<I, O> {
  const found = registry.get<I, O>(name);
  if (found === undefined) throw new Error(`the composed registry has no ${name}`);
  return found;
}

async function stored(): Promise<{ candidate: GenerationCandidate; runId: string }> {
  const run = aRun();
  expectValue(await runs.save(run));
  const candidate = aCandidate(run);
  expectValue(await candidates.save(candidate));
  return { candidate, runId: run.pin.runId };
}

describe('every handler the context declares is registered, through the application’s own composition', () => {
  it('registers a handler for every declared policy, under the policy’s own name', () => {
    const expected = GENERATION_POLICIES.map((entry) => entry.name);

    expect([...registry.names].sort()).toEqual([...expected].sort());
    expect(expected).toHaveLength(8);
    for (const entry of GENERATION_POLICIES) {
      expect(registry.get(entry.name)?.policy, entry.name).toBe(entry);
    }
  });

  it('names no policy-less handler, and no policy without a role', () => {
    for (const name of registry.names) {
      expect(registry.get(name)?.policy.allowedRoles.length, name).toBeGreaterThan(0);
    }
  });
});

describe('the composed query handlers, executed through the registry', () => {
  it('GetCandidate returns a stored candidate to Content Ops', async () => {
    const { candidate } = await stored();
    const found = expectValue(await handler<{ candidateId: string }, GenerationCandidate>('GetCandidate').handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    expect(found.candidateId).toBe(candidate.candidateId);
    expect(found.confidence).toBe(0.85);
  });

  it('GetCandidate refuses the machine, and reports a missing candidate as NotFound', async () => {
    const { candidate } = await stored();
    const get = handler<{ candidateId: string }, GenerationCandidate>('GetCandidate');
    expect(expectError(await get.handle({ candidateId: candidate.candidateId }, contextFor(pipeline))).code).toBe('NOT_PERMITTED');
    const missing = expectError(await get.handle({ candidateId: randomUUID() }, contextFor(ops)));
    expect(missing.kind).toBe('NotFound');
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('ListRunCandidates returns a run’s candidates, refuses the machine, and surfaces a store refusal', async () => {
    const { candidate, runId } = await stored();
    const list = handler<{ runId: string }, readonly GenerationCandidate[]>('ListRunCandidates');
    const listed = expectValue(await list.handle({ runId }, contextFor(ops)));
    expect(listed.map((entry) => entry.candidateId)).toEqual([candidate.candidateId]);
    expect(expectError(await list.handle({ runId }, contextFor(pipeline))).code).toBe('NOT_PERMITTED');
    expect(expectError(await list.handle({ runId: 'not-a-uuid' }, contextFor(ops))).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('the audit recorder in front of generation is the real one (M5-37)', () => {
  it('records a generation command in platform.audit_record under the context "generation"', async () => {
    const before = await database.pool.query(`SELECT count(*)::int AS n FROM platform.audit_record WHERE target_context = 'generation'`);
    const started = expectValue(
      await handler<unknown, { pin: { runId: string } }>('StartGenerationRun').handle(
        { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { itemType: 'single_choice' } },
        contextFor(pipeline, 'corr-audit-1'),
      ),
    );

    const { rows } = await database.pool.query(
      `SELECT action, target_type, target_id, correlation_id FROM platform.audit_record WHERE target_context = 'generation' AND correlation_id = 'corr-audit-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('StartGenerationRun');
    expect(rows[0].target_id).toBe(started.pin.runId);
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM platform.audit_record WHERE target_context = 'generation'`)).rows[0].n).toBe(before.rows[0].n + 1);
  });
});

describe('a deployment that supplied neither a provider nor a pre-check configuration is safe, not broken', () => {
  it('reports all twelve checks as blocked and records no verdict for any', async () => {
    const { candidate } = await stored();
    const report = expectValue(await handler<unknown, BatteryReport>('RunPrecheckBattery').handle({ candidateId: candidate.candidateId }, contextFor(pipeline)));

    expect(report.checks.map((line) => line.check).sort()).toEqual([...PRECHECK_IDS].sort());
    expect(report.checks.every((line) => line.status === 'blocked')).toBe(true);
    expect((await database.pool.query(`SELECT 1 FROM ai.candidate_verdict WHERE candidate_id = $1`, [candidate.candidateId])).rowCount).toBe(0);
  });

  it('therefore cannot accept anything: a blocking check that did not run is not one that passed', async () => {
    const { candidate } = await stored();
    expectValue(await handler<unknown, BatteryReport>('RunPrecheckBattery').handle({ candidateId: candidate.candidateId }, contextFor(pipeline)));
    const items = (await database.pool.query(`SELECT count(*)::int AS n FROM content.item`)).rows[0].n as number;

    expect(expectError(await handler('AcceptCandidate').handle({ candidateId: candidate.candidateId }, contextFor(ops))).code).toBe('CANDIDATE_NOT_PRECHECKED');
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM content.item`)).rows[0].n).toBe(items);
  });

  it('says a proposal is unavailable because no provider is configured, and creates no candidate', async () => {
    const started = expectValue(
      await handler<unknown, { pin: { runId: string } }>('StartGenerationRun').handle(
        { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { itemType: 'single_choice' } },
        contextFor(pipeline),
      ),
    );
    const failure = expectError(
      await handler('ProposeCandidate').handle({ runId: started.pin.runId, grounding: [], task: { itemType: 'single_choice' } }, contextFor(pipeline)),
    );
    expect(failure.kind).toBe('Unavailable');
    expect(failure.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect((await database.pool.query(`SELECT 1 FROM ai.generation_candidate WHERE run_id = $1`, [started.pin.runId])).rowCount).toBe(0);
  });
});
