import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { ensureVersions, registering, versionId } from '../../../../testing/generation-fixtures.js';
import { FIXED_NOW, RecordingAudit, contextFor, fixedClock, principalWith } from '../../../../testing/generation-context.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { PostgresAIBudgetRepository } from '../../infrastructure/ai-budget.repository.js';
import { PostgresEvaluationRunRepository } from '../../infrastructure/evaluation-run.repository.js';
import { RecordEvaluationRunHandler, StartGenerationRunHandler } from './run-handlers.js';

/**
 * F31 — no model or prompt version activates without a passing evaluation run (M5-43),
 * against real Postgres. A version is activated when a run names it.
 *
 * Each test works with versions of its own, minted fresh, so what a version has been
 * evaluated for is that test's to establish and nothing leaks between them.
 */
let database: TestDatabase;
let runs: GenerationRunRepository;
let evaluations: PostgresEvaluationRunRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  evaluations = new PostgresEvaluationRunRepository(database.pool);
  expectValue(
    await new PostgresAIBudgetRepository(database.pool).declare({ feature: 'generation', period: '2026-10', ceilingTokens: 1_000_000_000 }, { kind: 'human', id: randomUUID() }, FIXED_NOW.toISOString()),
  );
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const ops = principalWith(['content_ops']);
const pipeline = principalWith(['generation_pipeline'], 'system');

let counter = 5000;
/** A model version and a prompt version no one has evaluated. */
async function unevaluated() {
  counter += 1;
  const pin = { modelVersionId: versionId('model', counter), promptVersionId: versionId('prompt', counter) };
  await ensureVersions(database.pool, pin, { evaluated: false });
  return pin;
}

function recorder() {
  const audit = new RecordingAudit();
  return { audit, record: new RecordEvaluationRunHandler({ evaluations, identifiers: { next: () => randomUUID() }, clock: fixedClock, audit }) };
}

const starter = () =>
  new StartGenerationRunHandler({ runs, evaluations, clock: fixedClock, identifiers: { next: () => randomUUID() }, audit: new RecordingAudit() });

const runCount = async (): Promise<number> => (await database.pool.query('SELECT count(*)::int AS n FROM ai.generation_run')).rows[0].n as number;

const start = (pin: { modelVersionId: string; promptVersionId: string }) =>
  starter().handle({ ...pin, request: {}, budgetTokens: 1000 }, contextFor(pipeline));

async function evaluated(kind: 'model' | 'prompt', id: string, scores: Record<string, number>, baselineRunId?: string) {
  return recorder().record.handle(
    { subject: { kind, versionId: id }, corpus: 'golden-v1', scores, ...(baselineRunId === undefined ? {} : { baselineRunId }) },
    contextFor(ops),
  );
}

describe('a run cannot name a version with no passing evaluation run', () => {
  it('is refused, naming both versions, and nothing is written', async () => {
    const pin = await unevaluated();
    const before = await runCount();

    const failure = expectError(await start(pin));

    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('VERSION_NOT_EVALUATED');
    expect(failure.message).toContain(`model version ${pin.modelVersionId}`);
    expect(failure.message).toContain(`prompt version ${pin.promptVersionId}`);
    expect(await runCount()).toBe(before);
  });

  it('names only the one that lacks it', async () => {
    const pin = await unevaluated();
    expectValue(await evaluated('model', pin.modelVersionId, { generation_acceptance: 0.8 }));
    const failure = expectError(await start(pin));
    expect(failure.message).toContain(`prompt version ${pin.promptVersionId}`);
    expect(failure.message).not.toContain(`model version ${pin.modelVersionId}`);

    const other = await unevaluated();
    expectValue(await evaluated('prompt', other.promptVersionId, { generation_acceptance: 0.8 }));
    const second = expectError(await start(other));
    expect(second.message).toContain(`model version ${other.modelVersionId}`);
    expect(second.message).not.toContain(`prompt version ${other.promptVersionId}`);
  });

  it('starts once both have a passing evaluation', async () => {
    const pin = await unevaluated();
    expectValue(await evaluated('model', pin.modelVersionId, { generation_acceptance: 0.8 }));
    expectValue(await evaluated('prompt', pin.promptVersionId, { generation_acceptance: 0.8 }));
    expect(expectValue(await start(pin)).pin.modelVersionId).toBe(pin.modelVersionId);
  });

  it('answers a blank version id as a validation failure, not as a version nobody evaluated', async () => {
    const failure = expectError(await starter().handle({ modelVersionId: ' ', promptVersionId: versionId('prompt', 1), request: {}, budgetTokens: 1 }, contextFor(pipeline)));
    expect(failure.kind).toBe('Validation');
  });
});

describe('an evaluation store that cannot be read', () => {
  it('is a failure, never a version that passed: nothing is activated on a lookup that did not answer', async () => {
    const pin = await unevaluated();
    const unreadable = { hasPassing: async () => ({ ok: false as const, error: { kind: 'Validation' as const, code: 'PERSISTENCE_REJECTED' as const, message: 'store down' } }) };
    const handler = new StartGenerationRunHandler({ runs, evaluations: unreadable as never, clock: fixedClock, identifiers: { next: () => randomUUID() }, audit: new RecordingAudit() });
    const before = await runCount();
    expect(expectError(await handler.handle({ ...pin, request: {}, budgetTokens: 1000 }, contextFor(pipeline))).code).toBe('PERSISTENCE_REJECTED');
    expect(await runCount()).toBe(before);
  });
});

describe('regression blocks promotion: a regressed version is blocked, not warned about', () => {
  it('stores the regression as a fail, which does not activate — and the version it replaced still does', async () => {
    const current = await unevaluated();
    const baseline = expectValue(await evaluated('prompt', current.promptVersionId, { generation_acceptance: 0.8, verification_catch_rate: 0.97 }));
    expect(baseline.outcome).toBe('pass');
    expectValue(await evaluated('model', current.modelVersionId, { generation_acceptance: 0.8 }));

    // A candidate prompt: better at generating, worse at catching known-bad items.
    const candidate = await unevaluated();
    expectValue(await evaluated('model', candidate.modelVersionId, { generation_acceptance: 0.8 }));
    const regressed = expectValue(await evaluated('prompt', candidate.promptVersionId, { generation_acceptance: 0.95, verification_catch_rate: 0.96 }, baseline.evaluationRunId));

    expect(regressed.outcome).toBe('fail');
    expect(regressed.regressions).toEqual(['verification_catch_rate']);
    const stored = expectValue(await evaluations.findById(regressed.evaluationRunId));
    expect(stored.outcome).toBe('fail');
    expect(stored.baselineRunId).toBe(baseline.evaluationRunId);

    // The block, asserted: the regressed version cannot be named by a run. The version it would replace can.
    const blocked = expectError(await start(candidate));
    expect(blocked.code).toBe('VERSION_NOT_EVALUATED');
    expect(blocked.message).toContain(`prompt version ${candidate.promptVersionId}`);
    expectValue(await start(current));
  });

  it('lets a version that held on everything through, and records the baseline it held against', async () => {
    const current = await unevaluated();
    const baseline = expectValue(await evaluated('prompt', current.promptVersionId, { generation_acceptance: 0.8, verification_catch_rate: 0.97 }));
    const next = await unevaluated();
    expectValue(await evaluated('model', next.modelVersionId, { generation_acceptance: 0.8 }));
    const held = expectValue(await evaluated('prompt', next.promptVersionId, { generation_acceptance: 0.85, verification_catch_rate: 0.97 }, baseline.evaluationRunId));
    expect(held.outcome).toBe('pass');
    expectValue(await start(next));
  });

  it('does not let a failing evaluation stand in for a passing one: only a pass activates', async () => {
    const pin = await unevaluated();
    expectValue(await evaluated('model', pin.modelVersionId, { generation_acceptance: 0.8 }));
    expect(expectValue(await evaluated('prompt', pin.promptVersionId, { verification_catch_rate: 0.5 })).outcome).toBe('fail');
    expect(expectError(await start(pin)).code).toBe('VERSION_NOT_EVALUATED');
    // A later passing evaluation of the same version does activate it: the failure was an event, not a verdict on the version forever.
    expectValue(await evaluated('prompt', pin.promptVersionId, { verification_catch_rate: 0.96 }));
    expectValue(await start(pin));
  });
});

describe('RecordEvaluationRun', () => {
  it('derives the outcome and audits the recording under the person who made it', async () => {
    const pin = await unevaluated();
    const { record, audit } = recorder();
    const run = expectValue(await record.handle({ subject: { kind: 'model', versionId: pin.modelVersionId }, corpus: 'golden-v1', scores: { generation_acceptance: 0.7 } }, contextFor(ops, 'corr-eval-1')));

    expect(run.outcome).toBe('pass');
    expect(run.evaluatedAt).toBe(FIXED_NOW.toISOString());
    expect(audit.entries.map((entry) => [entry.action, entry.targetType, entry.targetId, entry.correlationId])).toEqual([['RecordEvaluationRun', 'EvaluationRun', run.evaluationRunId, 'corr-eval-1']]);
    const row = await database.pool.query(`SELECT evaluated_by_kind, evaluated_by_id, outcome FROM ai.evaluation_run WHERE evaluation_run_id = $1`, [run.evaluationRunId]);
    expect(row.rows).toEqual([{ evaluated_by_kind: ops.kind, evaluated_by_id: ops.id, outcome: 'pass' }]);
  });

  it('is Content Ops’ alone: the pipeline cannot certify the version it would then run', async () => {
    const pin = await unevaluated();
    for (const principal of [pipeline, principalWith(['author']), principalWith(['reviewer']), principalWith([])]) {
      const refused = expectError(await recorder().record.handle({ subject: { kind: 'model', versionId: pin.modelVersionId }, corpus: 'golden-v1', scores: { generation_acceptance: 1 } }, contextFor(principal)));
      expect(refused.code).toBe('NOT_PERMITTED');
    }
    expect(await database.pool.query(`SELECT 1 FROM ai.evaluation_run WHERE model_version_id = $1`, [pin.modelVersionId])).toHaveProperty('rowCount', 0);
  });

  it('refuses a version the registry does not hold, and a baseline that does not exist', async () => {
    const stranger = expectError(await evaluated('model', versionId('model', 9999), { generation_acceptance: 0.8 }));
    expect(stranger.code).toBe('PERSISTENCE_REJECTED');
    const pin = await unevaluated();
    expect(expectError(await evaluated('prompt', pin.promptVersionId, { generation_acceptance: 0.8 }, randomUUID())).kind).toBe('NotFound');
  });

  it('refuses scores that are not measurements, naming the field, and records nothing', async () => {
    const pin = await unevaluated();
    for (const [scores, location] of [[{}, 'scores'], [{ vibes: 1 }, 'scores.vibes'], [{ generation_acceptance: 1.5 }, 'scores.generation_acceptance']] as const) {
      const failure = expectError(await evaluated('model', pin.modelVersionId, scores));
      expect(failure.kind).toBe('Validation');
      expect(failure.location).toBe(location);
    }
    expect(await database.pool.query(`SELECT 1 FROM ai.evaluation_run WHERE model_version_id = $1`, [pin.modelVersionId])).toHaveProperty('rowCount', 0);
  });

  it('carries no outcome in its command, so one cannot be asserted: extra keys do not change what is derived', async () => {
    const pin = await unevaluated();
    const forged = { subject: { kind: 'prompt', versionId: pin.promptVersionId }, corpus: 'golden-v1', scores: { verification_catch_rate: 0.1 }, outcome: 'pass', regressions: [] };
    const run = expectValue(await recorder().record.handle(forged as never, contextFor(ops)));
    expect(run.outcome).toBe('fail');
  });
});

describe('F31 as a fact about the data — the planted activation', () => {
  // The application checks first and names the version; this is what is left when something skips it. A run is
  // inserted directly, as a path that forgot the check would, and the database refuses it.
  it('refuses a run inserted for an unevaluated model version, with the version in the message', async () => {
    const pin = await unevaluated();
    const planted = (async () =>
      database.pool.query(
        `INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request, budget_tokens) VALUES ($1, $2, now(), '{}', 1)`,
        [pin.modelVersionId, pin.promptVersionId],
      ))();
    await expect(planted).rejects.toThrow(new RegExp(`version_not_evaluated: model version ${pin.modelVersionId} has no passing evaluation run`, 'u'));
  });

  it('refuses it for an unevaluated prompt version when the model is evaluated', async () => {
    const pin = await unevaluated();
    expectValue(await evaluated('model', pin.modelVersionId, { generation_acceptance: 0.8 }));
    await expect(
      database.pool.query(`INSERT INTO ai.generation_run (model_version_id, prompt_version_id, requested_at, request, budget_tokens) VALUES ($1, $2, now(), '{}', 1)`, [pin.modelVersionId, pin.promptVersionId]),
    ).rejects.toThrow(new RegExp(`prompt version ${pin.promptVersionId}`, 'u'));
  });

  it('refuses it through the repository too, as a value naming the version', async () => {
    const pin = await unevaluated();
    const { aRun } = await import('../../../../testing/generation-fixtures.js');
    const failure = expectError(await new (await import('../../infrastructure/generation-run.repository.js')).PostgresGenerationRunRepository(database.pool).save(aRun(pin)));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain(pin.modelVersionId);
  });

  it('refuses a failing evaluation as a pass at the table: a regression cannot be stored as one', async () => {
    const pin = await unevaluated();
    await expect(
      database.pool.query(
        `INSERT INTO ai.evaluation_run (model_version_id, corpus, scores, regressions, outcome, evaluated_by_kind, evaluated_by_id, evaluated_at)
         VALUES ($1, 'golden-v1', '{"generation_acceptance": 0.1}', ARRAY['generation_acceptance'], 'pass', 'human', gen_random_uuid(), now())`,
        [pin.modelVersionId],
      ),
    ).rejects.toThrow(/evaluation_run_pass_has_no_regressions/u);
  });

  it('refuses an evaluation that names no version, or both', async () => {
    const pin = await unevaluated();
    for (const [model, prompt] of [[null, null], [pin.modelVersionId, pin.promptVersionId]]) {
      await expect(
        database.pool.query(
          `INSERT INTO ai.evaluation_run (model_version_id, prompt_version_id, corpus, scores, regressions, outcome, evaluated_by_kind, evaluated_by_id, evaluated_at)
           VALUES ($1, $2, 'golden-v1', '{"generation_acceptance": 0.9}', '{}', 'pass', 'human', gen_random_uuid(), now())`,
          [model, prompt],
        ),
      ).rejects.toThrow(/evaluation_run_exactly_one_subject/u);
    }
  });

  it('refuses to read back a stored run whose outcome its scores do not derive', async () => {
    const pin = await unevaluated();
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO ai.evaluation_run (evaluation_run_id, model_version_id, corpus, scores, regressions, outcome, evaluated_by_kind, evaluated_by_id, evaluated_at)
       VALUES ($1, $2, 'golden-v1', '{"verification_catch_rate": 0.2}', '{}', 'pass', 'human', gen_random_uuid(), now())`,
      [id, pin.modelVersionId],
    );
    const failure = expectError(await evaluations.findById(id));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('derive fail');
  });
});
