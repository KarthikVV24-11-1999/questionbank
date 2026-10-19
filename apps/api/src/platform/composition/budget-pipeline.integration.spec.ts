import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenUsage } from '../../contexts/generation/domain/ai-spend.js';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import type { PrecheckConfig } from '../../contexts/generation/application/prechecks/judge.js';
import type { HandlerRegistry } from '../../contexts/generation/application/handler-registry.js';
import type { JudgementProvider, ProposalProvider } from '../../contexts/generation/application/ports.js';
import type { GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { PostgresAISpendLedger } from '../../contexts/generation/infrastructure/ai-spend-ledger.repository.js';
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';
import { aTaxonomy } from '../../testing/published-taxonomy.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, ensureVersions, versionId } from '../../testing/generation-fixtures.js';
import { composeGeneration, type ComposedGeneration } from '../../testing/composed-generation.js';
import { contextFor, principalWith } from '../../testing/generation-context.js';

/**
 * The budget and the ledger through the application as it is composed (M5-41, M5-42):
 * the real registry, the real meter around the provider, real Postgres. The provider
 * is the recorded one, so nothing here costs anything — which is the point of
 * testing the budget against it.
 *
 * A spy sits *under* the meter and writes down every usage the provider actually
 * returned. That is the independent account the ledger is held against: what the
 * ledger records is compared with what the provider said it spent, not with what the
 * ledger itself reports.
 */
const RECORDINGS = resolve(dirname(fileURLToPath(import.meta.url)), '../../contexts/generation/infrastructure/provider/recordings');
const TASK = (name: string) => (JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as { request: { grounding: never; task: Record<string, unknown> } }).request;
const RAMP_TAG = ((JSON.parse(readFileSync(join(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as { response: { body: { taxonomyTags: { conceptIdentityId: string; taxonomyVersionId: string }[] } } }).response.body.taxonomyTags)[0]!;

const CONFIG: PrecheckConfig = {
  answer_verification: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20) },
  item_solution_key_consistency: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 21) },
  distractor_validity: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 22) },
  ambiguity_clarity: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 23) },
  safety_appropriateness: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 24) },
  syllabus_scope: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 25) },
};

interface Returned {
  readonly runId: string;
  readonly kind: 'propose' | 'judge';
  readonly usage: TokenUsage;
}

let database: TestDatabase;
let composed: ComposedGeneration;
let registry: HandlerRegistry;
let ledger: PostgresAISpendLedger;
const returned: Returned[] = [];

/** The recorded provider, seen from underneath the meter. */
function spy(inner: ProposalProvider & JudgementProvider): ProposalProvider & JudgementProvider {
  return {
    async propose(request) {
      const result = await inner.propose(request);
      if (result.ok) returned.push({ runId: request.budgetScope.runId, kind: 'propose', usage: result.value.usage });
      return result;
    },
    async judge(request) {
      const result = await inner.judge(request);
      if (result.ok) returned.push({ runId: request.budgetScope.runId, kind: 'judge', usage: result.value.usage });
      return result;
    },
  };
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  await aTaxonomy(database, { versionId: RAMP_TAG.taxonomyVersionId, conceptIdentityId: RAMP_TAG.conceptIdentityId, displayName: 'Kinematics', publish: true });
  composed = await composeGeneration(database, { provider: spy(RecordedProvider.fromDirectory(RECORDINGS)), precheckConfig: CONFIG });
  registry = composed.registry;
  ledger = new PostgresAISpendLedger(database.pool);
});

afterAll(async () => {
  await composed.close();
  await database.revertMigrations();
  await database.close();
});

const machine = principalWith(['generation_pipeline', 'subject:physics'], 'system');
const ops = principalWith(['content_ops']);

function handle<I, O>(name: string, input: I, principal = machine) {
  const found = registry.get<I, O>(name);
  if (found === undefined) throw new Error(`no handler ${name}`);
  return found.handle(input, contextFor(principal, 'corr-budget-e2e'));
}

async function startRun(budgetTokens: number, proposal = 'kinematics-ramp.json') {
  const { task } = TASK(proposal);
  return expectValue(await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: task, budgetTokens }, ops));
}

const sum = (entries: readonly Returned[]) => entries.reduce((total, entry) => total + entry.usage.inputTokens + entry.usage.outputTokens, 0);
const ofRun = (runId: string) => returned.filter((entry) => entry.runId === runId);

describe('what the budget counts is what the ledger records (M5-42)', () => {
  it('records exactly what the provider returned, for the proposal and every judged check, as one entry each', async () => {
    const run = await startRun(1_000_000);
    const { grounding, task } = TASK('kinematics-ramp.json');
    const candidate = expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const calls = ofRun(run.pin.runId);
    expect(calls.map((call) => call.kind).filter((kind) => kind === 'propose')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'judge').length).toBeGreaterThanOrEqual(6);

    const { rows } = await database.pool.query(`SELECT call_kind, input_tokens::int AS i, output_tokens::int AS o FROM ai.ai_spend_ledger WHERE run_id = $1`, [run.pin.runId]);
    expect(rows).toHaveLength(calls.length);
    // As multisets: rows carry no order the provider's calls could be matched against.
    const keyed = (entries: readonly (readonly [string, number, number])[]) => entries.map((entry) => entry.join(':')).sort();
    expect(keyed(rows.map((row: { call_kind: string; i: number; o: number }) => [row.call_kind, row.i, row.o] as const))).toEqual(
      keyed(calls.map((call) => [call.kind, call.usage.inputTokens, call.usage.outputTokens] as const)),
    );
  });

  it('counts the same total the provider reported: what a run is held to is what the ledger holds', async () => {
    const run = await startRun(1_000_000);
    const { grounding, task } = TASK('kinematics-ramp.json');
    const candidate = expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const expected = sum(ofRun(run.pin.runId));
    expect(expected).toBeGreaterThan(0);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(expected);
    const direct = await database.pool.query(`SELECT SUM(input_tokens + output_tokens)::int AS n FROM ai.ai_spend_ledger WHERE run_id = $1`, [run.pin.runId]);
    expect(direct.rows[0].n).toBe(expected);
    // And the month's figure is the sum of its runs', not a separate count.
    const everything = await database.pool.query(`SELECT SUM(total_tokens)::int AS n FROM ai.ai_spend_ledger WHERE feature = 'generation'`);
    expect(expectValue(await ledger.spentInPeriod('generation', '2026-10'))).toBe(everything.rows[0].n);
    expect(sum(returned)).toBe(everything.rows[0].n);
  });

  it('attributes a judged check’s spend to the check’s own model and prompt, not the candidate’s', async () => {
    const run = await startRun(1_000_000);
    const { grounding, task } = TASK('kinematics-ramp.json');
    const candidate = expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const { rows } = await database.pool.query(`SELECT DISTINCT prompt_version_id FROM ai.ai_spend_ledger WHERE run_id = $1 AND call_kind = 'judge'`, [run.pin.runId]);
    const prompts = rows.map((row: { prompt_version_id: string }) => row.prompt_version_id).sort();
    expect(prompts).toEqual(Object.values(CONFIG).map((entry) => entry.promptVersionId).sort());
    expect(prompts).not.toContain(PROMPT_VERSION);
    // "What did prompt v20 cost?" is one query.
    const verification = await database.pool.query(`SELECT SUM(total_tokens)::int AS n FROM ai.ai_spend_ledger WHERE prompt_version_id = $1`, [CONFIG.answer_verification!.promptVersionId]);
    expect(verification.rows[0].n).toBeGreaterThan(0);
  });
});

describe('a run cannot spend past what it reserved, and is stopped before the provider is reached', () => {
  it('lets the proposal through, then refuses each judged check as RUN_BUDGET_EXHAUSTED — nothing more is spent', async () => {
    const run = await startRun(1);
    const { grounding, task } = TASK('kinematics-ramp.json');
    const candidate = expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    expect(ofRun(run.pin.runId)).toHaveLength(1);

    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const judged = report.checks.filter((line) => line.status === 'could_not_run');
    expect(judged.length).toBeGreaterThanOrEqual(5);
    expect(judged.every((line) => line.error?.code === 'RUN_BUDGET_EXHAUSTED')).toBe(true);
    expect(ofRun(run.pin.runId)).toHaveLength(1);
    expect(expectValue(await ledger.spentByRun(run.pin.runId))).toBe(sum(ofRun(run.pin.runId)));
    // Not a pass: a check that could not run records nothing, so the candidate is undecided rather than accepted.
    expect(report.disposition).toEqual({ status: 'undecided' });
  });

  it('refuses a run that would not fit its month, before anything is dispatched or spent', async () => {
    const callsBefore = returned.length;
    const ledgerBefore = (await database.pool.query(`SELECT count(*)::int AS n FROM ai.ai_spend_ledger`)).rows[0].n as number;
    // The composed application declares 1,000,000,000 tokens for the month.
    const refused = expectError(await handle('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: {}, budgetTokens: 1_000_000_001 }, ops));

    expect(refused.code).toBe('RUN_EXCEEDS_BUDGET');
    expect(returned.length).toBe(callsBefore);
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM ai.ai_spend_ledger`)).rows[0].n).toBe(ledgerBefore);
  });

  it('refuses a proposal charged to a run that does not exist, and calls no provider', async () => {
    const callsBefore = returned.length;
    const { grounding, task } = TASK('kinematics-ramp.json');
    const refused = expectError(await handle('ProposeCandidate', { runId: '00000000-0000-4000-8000-00000000dead', grounding, task }));
    expect(refused.kind).toBe('NotFound');
    expect(returned.length).toBe(callsBefore);
  });
});
