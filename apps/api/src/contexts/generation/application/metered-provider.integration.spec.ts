import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, aRun, ensureVersions, registering, versionId } from '../../../testing/generation-fixtures.js';
import { FIXED_NOW, fixedClock } from '../../../testing/generation-context.js';
import { createSpendEntry } from '../domain/ai-spend.js';
import { err, ok } from '../domain/result.js';
import type { AISpendLedger, GenerationRunRepository } from '../domain/repository-ports.js';
import { PostgresEvaluationRunRepository } from '../infrastructure/evaluation-run.repository.js';
import { PostgresAIBudgetRepository } from '../infrastructure/ai-budget.repository.js';
import { PostgresAISpendLedger } from '../infrastructure/ai-spend-ledger.repository.js';
import { applicationError } from './authorization.js';
import { MeteredProvider } from './metered-provider.js';
import type { JudgementProvider, JudgementRequest, ProposalProvider, ProposalRequest } from './ports.js';

/**
 * The meter, against real Postgres (M5-42). The provider underneath is scripted —
 * what is under test is what the meter does around a call, not what a model says —
 * and it counts the calls it receives, because "refused before dispatch" is a claim
 * about that count.
 */
let database: TestDatabase;
let runs: GenerationRunRepository;
let ledger: PostgresAISpendLedger;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  ledger = new PostgresAISpendLedger(database.pool);
  expectValue(
    await new PostgresAIBudgetRepository(database.pool).declare({ feature: 'generation', period: '2026-10', ceilingTokens: 1_000_000_000 }, { kind: 'human', id: randomUUID() }, FIXED_NOW.toISOString()),
  );
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

interface Scripted extends ProposalProvider, JudgementProvider {
  readonly calls: { readonly kind: string }[];
}

function scripted(usage = { inputTokens: 600, outputTokens: 400 }, answer: 'ok' | 'unavailable' = 'ok'): Scripted {
  const calls: { kind: string }[] = [];
  return {
    calls,
    async propose() {
      calls.push({ kind: 'propose' });
      return answer === 'ok' ? ok({ itemType: 'SINGLE_CORRECT_MCQ', body: {}, confidence: 0.9, usage }) : err(applicationError('Unavailable', 'PROVIDER_DOWN', 'down'));
    },
    async judge() {
      calls.push({ kind: 'judge' });
      return answer === 'ok' ? ok({ output: {}, usage }) : err(applicationError('Unavailable', 'PROVIDER_DOWN', 'down'));
    },
  };
}

async function reserved(budgetTokens: number) {
  const run = aRun({ budgetTokens });
  expectValue(await runs.save(run));
  return run;
}

function metered(inner: Scripted, overrides: { ledger?: AISpendLedger } = {}) {
  return new MeteredProvider({ inner, runs, evaluations: new PostgresEvaluationRunRepository(database.pool), ledger: overrides.ledger ?? ledger, clock: fixedClock, identifiers: { next: () => randomUUID() } });
}

const proposalFor = (runId: string, pin = { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION }): ProposalRequest => ({
  budgetScope: { feature: 'generation', runId },
  pin: { ...pin, runId },
  grounding: [],
  task: {},
});
const judgementFor = (runId: string, modelVersionId: string, promptVersionId: string): JudgementRequest => ({
  budgetScope: { feature: 'generation', runId },
  modelVersionId,
  promptVersionId,
  input: {},
});

describe('what the meter records', () => {
  it('appends one ledger row per answered call, attributed to the version it ran under and the run it is charged to', async () => {
    const run = await reserved(1_000_000);
    const verifier = { modelVersionId: versionId('model', 41), promptVersionId: versionId('prompt', 42) };
    await ensureVersions(database.pool, verifier);
    const inner = scripted({ inputTokens: 700, outputTokens: 300 });
    const provider = metered(inner);

    expectValue(await provider.propose(proposalFor(run.pin.runId)));
    expectValue(await provider.judge(judgementFor(run.pin.runId, verifier.modelVersionId, verifier.promptVersionId)));

    const { rows } = await database.pool.query(
      `SELECT feature, run_id, model_version_id, prompt_version_id, call_kind, input_tokens::int AS i, output_tokens::int AS o, total_tokens::int AS t, occurred_at
         FROM ai.ai_spend_ledger WHERE run_id = $1 ORDER BY call_kind DESC`,
      [run.pin.runId],
    );
    expect(rows).toEqual([
      { feature: 'generation', run_id: run.pin.runId, model_version_id: MODEL_VERSION, prompt_version_id: PROMPT_VERSION, call_kind: 'propose', i: 700, o: 300, t: 1000, occurred_at: FIXED_NOW },
      { feature: 'generation', run_id: run.pin.runId, model_version_id: verifier.modelVersionId, prompt_version_id: verifier.promptVersionId, call_kind: 'judge', i: 700, o: 300, t: 1000, occurred_at: FIXED_NOW },
    ]);
  });

  it('records nothing for a call the provider could not answer, and returns the provider’s failure as it is', async () => {
    const run = await reserved(1_000_000);
    const failure = expectError(await metered(scripted(undefined, 'unavailable')).propose(proposalFor(run.pin.runId)));
    expect(failure.code).toBe('PROVIDER_DOWN');
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(0);
  });

  it('does not return an answer whose spend it could not record: nobody can account for it', async () => {
    const run = await reserved(1_000_000);
    const refusing: AISpendLedger = {
      append: async () => err({ kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'store down' }),
      spentByRun: (runId) => ledger.spentByRun(runId),
      spentInPeriod: (feature, period) => ledger.spentInPeriod(feature, period),
    };
    const failure = expectError(await metered(scripted(), { ledger: refusing }).propose(proposalFor(run.pin.runId)));
    expect(failure.kind).toBe('Unavailable');
    expect(failure.code).toBe('SPEND_NOT_RECORDED');
  });

  it('surfaces a ledger that cannot be read as a failure, never as a run with nothing spent', async () => {
    const run = await reserved(1_000_000);
    const blind: AISpendLedger = {
      append: (entry) => ledger.append(entry),
      spentByRun: async () => err({ kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'store down' }),
      spentInPeriod: (feature, period) => ledger.spentInPeriod(feature, period),
    };
    const inner = scripted();
    expect(expectError(await metered(inner, { ledger: blind }).propose(proposalFor(run.pin.runId))).code).toBe('PERSISTENCE_REJECTED');
    expect(inner.calls).toEqual([]);
  });
});

describe('what the meter refuses, before the provider is reached', () => {
  it('refuses once the run has consumed everything it reserved, and the provider is never called again', async () => {
    const run = await reserved(1_000);
    const inner = scripted({ inputTokens: 600, outputTokens: 400 });
    const provider = metered(inner);

    expectValue(await provider.propose(proposalFor(run.pin.runId)));
    const refused = expectError(await provider.propose(proposalFor(run.pin.runId)));

    expect(refused.kind).toBe('PreconditionFailed');
    expect(refused.code).toBe('RUN_BUDGET_EXHAUSTED');
    expect(refused.message).toContain('1000 of the 1000');
    expect(inner.calls).toHaveLength(1);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(1_000);
  });

  it('lets a call start while a single token of the reservation remains, and refuses at the boundary (D50)', async () => {
    const run = await reserved(1_001);
    const inner = scripted({ inputTokens: 600, outputTokens: 400 });
    const provider = metered(inner);

    expectValue(await provider.propose(proposalFor(run.pin.runId)));
    // 1,000 of 1,001 consumed: one token left, so this call is allowed, and it takes the run to 2,000.
    expectValue(await provider.propose(proposalFor(run.pin.runId)));
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(2_000);
    expect(expectError(await provider.propose(proposalFor(run.pin.runId))).code).toBe('RUN_BUDGET_EXHAUSTED');
    expect(inner.calls).toHaveLength(2);
  });

  it('refuses a scope that names no run, and the provider is not called', async () => {
    const inner = scripted();
    const refused = expectError(await metered(inner).propose(proposalFor(randomUUID())));
    expect(refused.code).toBe('BUDGET_SCOPE_UNKNOWN_RUN');
    expect(refused.location).toBe('budgetScope');
    expect(inner.calls).toEqual([]);
  });

  it('charges each run from its own reservation: one run’s exhaustion does not close another', async () => {
    const spent = await reserved(500);
    const fresh = await reserved(500);
    const provider = metered(scripted({ inputTokens: 300, outputTokens: 300 }));
    expectValue(await provider.propose(proposalFor(spent.pin.runId)));
    expect(expectError(await provider.propose(proposalFor(spent.pin.runId))).code).toBe('RUN_BUDGET_EXHAUSTED');
    expectValue(await provider.propose(proposalFor(fresh.pin.runId)));
  });
});

describe('a call naming a version with no passing evaluation is refused before dispatch (F31)', () => {
  it('refuses a judged check configured with an unevaluated prompt, naming it, and never reaches the provider', async () => {
    const run = await reserved(1_000_000);
    const verifier = { modelVersionId: versionId('model', 61), promptVersionId: versionId('prompt', 62) };
    await ensureVersions(database.pool, verifier, { evaluated: false });
    const inner = scripted();

    const refused = expectError(await metered(inner).judge(judgementFor(run.pin.runId, verifier.modelVersionId, verifier.promptVersionId)));

    expect(refused.kind).toBe('PreconditionFailed');
    expect(refused.code).toBe('VERSION_NOT_EVALUATED');
    expect(refused.message).toContain(`model version ${verifier.modelVersionId}`);
    expect(refused.message).toContain(`prompt version ${verifier.promptVersionId}`);
    expect(inner.calls).toEqual([]);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(0);
  });

  it('lets the same call through once its versions pass an evaluation', async () => {
    const run = await reserved(1_000_000);
    const verifier = { modelVersionId: versionId('model', 63), promptVersionId: versionId('prompt', 64) };
    await ensureVersions(database.pool, verifier);
    const inner = scripted();
    expectValue(await metered(inner).judge(judgementFor(run.pin.runId, verifier.modelVersionId, verifier.promptVersionId)));
    expect(inner.calls).toHaveLength(1);
  });

  it('surfaces an evaluation store that cannot be read as a failure, never as a version that passed', async () => {
    const run = await reserved(1_000_000);
    const unreadable = { hasPassing: async () => err({ kind: 'Validation' as const, code: 'PERSISTENCE_REJECTED' as const, message: 'store down' }) };
    const inner = scripted();
    const provider = new MeteredProvider({ inner, runs, evaluations: unreadable as never, ledger, clock: fixedClock, identifiers: { next: () => randomUUID() } });
    expect(expectError(await provider.propose(proposalFor(run.pin.runId))).code).toBe('PERSISTENCE_REJECTED');
    expect(inner.calls).toEqual([]);
  });
});

describe('the ledger is the one source of what was consumed', () => {
  it('sums what a run consumed, and zero for a run that consumed nothing', async () => {
    const run = await reserved(1_000_000);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(0);
    const provider = metered(scripted({ inputTokens: 123, outputTokens: 45 }));
    for (let call = 0; call < 3; call += 1) expectValue(await provider.propose(proposalFor(run.pin.runId)));
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(3 * (123 + 45));
  });

  it('agrees with a SUM written independently in SQL, for the run and for the month', async () => {
    const run = await reserved(1_000_000);
    const provider = metered(scripted({ inputTokens: 250, outputTokens: 50 }));
    for (let call = 0; call < 4; call += 1) expectValue(await provider.propose(proposalFor(run.pin.runId)));

    const direct = await database.pool.query(`SELECT SUM(input_tokens + output_tokens)::int AS n FROM ai.ai_spend_ledger WHERE run_id = $1`, [run.pin.runId]);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(direct.rows[0].n);
    const month = await database.pool.query(`SELECT SUM(input_tokens + output_tokens)::int AS n FROM ai.ai_spend_ledger WHERE feature = 'generation' AND to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM') = '2026-10'`);
    expect(expectValue(await ledger.spentInPeriod('generation', '2026-10'))).toBe(month.rows[0].n);
  });

  // The month's bounds are SQL (shared with the run repository) and its name is TypeScript (`periodOf`).
  it('puts the last millisecond of a month in that month and the first of the next in the next', async () => {
    const run = await reserved(1_000_000);
    const lastOfMarch = createSpendEntry({ ledgerId: randomUUID(), feature: 'boundary', runId: run.pin.runId, modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, kind: 'propose', usage: { inputTokens: 7, outputTokens: 0 }, occurredAt: '2031-03-31T23:59:59.999Z' });
    const firstOfApril = createSpendEntry({ ledgerId: randomUUID(), feature: 'boundary', runId: run.pin.runId, modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, kind: 'propose', usage: { inputTokens: 11, outputTokens: 0 }, occurredAt: '2031-04-01T00:00:00.000Z' });
    expectValue(await ledger.append(expectValue(lastOfMarch)));
    expectValue(await ledger.append(expectValue(firstOfApril)));

    expect(expectValue(await ledger.spentInPeriod('boundary', '2031-03'))).toBe(7);
    expect(expectValue(await ledger.spentInPeriod('boundary', '2031-04'))).toBe(11);
    expect(expectValue(await ledger.spentInPeriod('boundary', '2031-05'))).toBe(0);
  });

  it('refuses an entry that is not a whole, non-negative usage, and one that names a run or version the registry does not hold', async () => {
    const run = await reserved(1_000_000);
    const entry = (over: Record<string, unknown>) => ({ ledgerId: randomUUID(), feature: 'generation', runId: run.pin.runId, modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, kind: 'propose' as const, usage: { inputTokens: 1, outputTokens: 1 }, occurredAt: FIXED_NOW.toISOString(), ...over });
    for (const bad of [{ usage: { inputTokens: -1, outputTokens: 0 } }, { usage: { inputTokens: 1.5, outputTokens: 0 } }, { kind: 'dream' }, { feature: ' ' }, { occurredAt: 'yesterday' }]) {
      expect(expectError(await ledger.append(entry(bad) as never)).code, JSON.stringify(bad)).toBe('PERSISTENCE_REJECTED');
    }
    expect(expectError(await ledger.append(entry({ runId: randomUUID() }))).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await ledger.append(entry({ modelVersionId: versionId('model', 999) }))).code).toBe('PERSISTENCE_REJECTED');
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(0);
  });
});
