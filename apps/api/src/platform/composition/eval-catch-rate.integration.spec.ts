import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import type { PrecheckConfig } from '../../contexts/generation/application/prechecks/judge.js';
import type { HandlerRegistry } from '../../contexts/generation/application/handler-registry.js';
import type { EvaluationRun } from '../../contexts/generation/domain/evaluation-run.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';
import { composeGeneration, type ComposedGeneration } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { buildEvalCorpus, DEFECTS, DEFECT_PLAN, EVAL_CONCEPT_ID, EVAL_CORPUS_VERSION, EVAL_TAXONOMY_VERSION_ID, type EvalCorpus } from '../../testing/eval/eval-corpus.js';
import { evalOracle, type PromptOfCheck } from '../../testing/eval/eval-oracle.js';
import { describeEvaluation, evalRunner, reportOf, type EvalItemResult, type EvalReport } from '../../testing/eval/eval-run.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, ensureVersions, versionId } from '../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../testing/generation-context.js';
import { aTaxonomy } from '../../testing/published-taxonomy.js';

/**
 * F34 — verification catch rate on known-bad items is at least 95% — measured, as a
 * number, over the 100 known-bad negative controls (M5-44, DEC-M5-4), through the
 * application as it is composed: the real registry, the real meter, curriculum's
 * real taxonomy, content's real validator and handlers, real Postgres.
 *
 * What this does and does not establish is in the report's own words
 * (`describeEvaluation`) and is asserted below, because a number reported without
 * what it measures is the thing the scoring golden set was built to avoid: every item
 * is synthetic, the judged checks are answered by an oracle, and zero official items
 * means this is not a validated run.
 */
const CONFIG: PrecheckConfig = {
  answer_verification: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20) },
  item_solution_key_consistency: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 21) },
  distractor_validity: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 22) },
  ambiguity_clarity: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 23) },
  safety_appropriateness: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 24) },
  syllabus_scope: { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 25) },
};
const PROMPT_OF_CHECK: PromptOfCheck = Object.fromEntries(Object.entries(CONFIG).map(([check, pin]) => [check, pin.promptVersionId]));

const corpus: EvalCorpus = buildEvalCorpus();

/**
 * The two misses nobody planted. `\sqrt[` — an optional argument opened and never closed — is malformed
 * TeX, and the renderability check accepts it (D52). They stay in the corpus: dropping a miss to reach a
 * number is the narrowing this milestone is not allowed to do. Asserted as a set, so if the renderer starts
 * rejecting them this fails and the number is updated on purpose.
 */
const UNTERMINATED_OPTIONAL_ARGUMENT = '\\sqrt[';
const renderabilityMisses = corpus.knownBad
  .filter((item) => item.defect === 'unrenderable_notation')
  .filter((item) => (item.body['stem'] as { blocks: { latex?: string }[] }).blocks.some((block) => block.latex === UNTERMINATED_OPTIONAL_ARGUMENT))
  .map((item) => item.id);
const machine = principalWith(['generation_pipeline', 'subject:physics'], 'system');
const ops = principalWith(['content_ops']);

let database: TestDatabase;
let composed: ComposedGeneration;
let registry: HandlerRegistry;
let candidates: PostgresGenerationCandidateRepository;

function handle<I, O>(name: string, input: I, principal = machine) {
  const found = registry.get<I, O>(name);
  if (found === undefined) throw new Error(`no handler ${name}`);
  return found.handle(input, contextFor(principal, 'corr-eval'));
}

async function composeWith(oracleOptions: Parameters<typeof evalOracle>[2] = {}) {
  const everything = [...corpus.knownBad, ...corpus.positives];
  composed = await composeGeneration(database, { provider: evalOracle(everything, PROMPT_OF_CHECK, oracleOptions), precheckConfig: CONFIG });
  registry = composed.registry;
}

/** Runs the whole corpus once, sequentially, and reports. */
async function runCorpus(): Promise<{ report: EvalReport; known: EvalItemResult[]; positives: EvalItemResult[] }> {
  const runner = evalRunner({
    startRun: async () =>
      expectValue(await handle<unknown, { pin: { modelVersionId: string; promptVersionId: string; runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { corpus: EVAL_CORPUS_VERSION }, budgetTokens: 1_000_000 }, ops)),
    candidates,
    runBattery: async (candidateId) => expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId })),
  });
  const known: EvalItemResult[] = [];
  for (const item of corpus.knownBad) known.push(await runner.run(item));
  const positives: EvalItemResult[] = [];
  for (const item of corpus.positives) positives.push(await runner.run(item));
  return { report: reportOf(corpus, known, positives), known, positives };
}

let baseline: { report: EvalReport; known: EvalItemResult[]; positives: EvalItemResult[] };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  await aTaxonomy(database, { versionId: EVAL_TAXONOMY_VERSION_ID, conceptIdentityId: EVAL_CONCEPT_ID, displayName: 'Kinematics', publish: true });
  candidates = new PostgresGenerationCandidateRepository(database.pool);
  await composeWith();
  baseline = await runCorpus();
  // eslint-disable-next-line no-console
  console.log(`\n${describeEvaluation(baseline.report)}\n`);
}, 300_000);

afterAll(async () => {
  await composed.close();
  await database.revertMigrations();
  await database.close();
});

describe('F34 — the verification catch rate, as a number', () => {
  it('catches at least 95% of the 100 known-bad items', () => {
    expect(baseline.report.knownBad).toBe(100);
    expect(baseline.report.catchRate).toBeGreaterThanOrEqual(0.95);
  });

  it('is 95 of 100, exactly — and the five it missed are named: three it has no check for, two it should have caught', () => {
    expect(baseline.report.caught).toBe(95);
    expect(baseline.report.catchRate).toBe(0.95);
    const mislabels = corpus.knownBad.filter((item) => item.defect === 'difficulty_mislabel').map((item) => item.id);
    expect(renderabilityMisses).toHaveLength(2);
    expect([...baseline.report.missed].sort()).toEqual([...mislabels, ...renderabilityMisses].sort());
  });

  it('catches every defect it has a check for, each by the check that owns it', () => {
    for (const result of baseline.known) {
      const defect = result.item.defect!;
      const owner = DEFECT_PLAN[defect].caughtBy;
      if (owner === undefined || renderabilityMisses.includes(result.item.id)) continue;
      expect(result.disposition, `${result.item.id} (${defect})`).toBe('rejected');
      expect(result.failedBlocking, `${result.item.id} (${defect})`).toContain(owner);
    }
  });

  it('accounts for every defect: the breakdown is the plan, caught for the checkable and none for the uncheckable', () => {
    for (const defect of DEFECTS) {
      const expected = DEFECT_PLAN[defect];
      const missedHere = defect === 'unrenderable_notation' ? renderabilityMisses.length : 0;
      expect(baseline.report.byDefect[defect], defect).toEqual({ total: expected.count, caught: expected.caughtBy === undefined ? 0 : expected.count - missedHere });
    }
  });

  it('does not block what it should let through: all 40 synthetic positives are accepted, and none is a false block', () => {
    expect(baseline.report.positives).toBe(40);
    expect(baseline.report.positivesAccepted).toBe(40);
    expect(baseline.positives.every((result) => result.failedBlocking.length === 0)).toBe(true);
  });

  it('says in words what the number is and is not — zero official items, an oracle for the judged half', () => {
    const words = describeEvaluation(baseline.report);
    expect(baseline.report.officialItems).toBe(0);
    expect(words).toContain('0 official items');
    expect(words).toContain('not a validated run');
    expect(words).toContain('95 of 100 = 95.0%');
    expect(words).toContain('missed:');
    expect(words).toContain('oracle');
    expect(words).toContain('not first-pass reviewer acceptance');
    expect(words).toContain('(B1)');
  });
});

describe('F34 feeds F31: the measured numbers are the evidence a version is promoted on', () => {
  const scores = () => ({ verification_catch_rate: baseline.report.catchRate, generation_acceptance: baseline.report.positivesAccepted / baseline.report.positives });
  const evaluate = (subject: { kind: 'prompt' | 'model'; versionId: string }, withScores: Record<string, number>, baselineRunId?: string) =>
    handle<unknown, EvaluationRun>('RecordEvaluationRun', { subject, corpus: EVAL_CORPUS_VERSION, scores: withScores, ...(baselineRunId === undefined ? {} : { baselineRunId }) }, ops);

  it('records the measured catch rate as a passing evaluation of a prompt version', async () => {
    const pin = { modelVersionId: versionId('model', 8001), promptVersionId: versionId('prompt', 8001) };
    await ensureVersions(database.pool, pin, { evaluated: false });
    const recorded = expectValue(await evaluate({ kind: 'prompt', versionId: pin.promptVersionId }, scores()));
    expect(recorded.outcome).toBe('pass');
    expect(recorded.scores.verification_catch_rate).toBe(0.95);
  });

  it('refuses to promote a version whose measured catch rate misses the floor, and blocks it — not a warning', async () => {
    const pin = { modelVersionId: versionId('model', 8002), promptVersionId: versionId('prompt', 8002) };
    await ensureVersions(database.pool, pin, { evaluated: false });
    expectValue(await evaluate({ kind: 'model', versionId: pin.modelVersionId }, { generation_acceptance: 1 }));
    const failed = expectValue(await evaluate({ kind: 'prompt', versionId: pin.promptVersionId }, { verification_catch_rate: 0.94 }));
    expect(failed.outcome).toBe('fail');
    expect(failed.regressions).toEqual(['verification_catch_rate']);

    const blocked = expectError(await handle('StartGenerationRun', { ...pin, request: {}, budgetTokens: 1000 }, ops));
    expect(blocked.code).toBe('VERSION_NOT_EVALUATED');
    expect(blocked.message).toContain(pin.promptVersionId);
  });
});

describe('the catch rate is red when a check stops working — seen, not assumed', () => {
  // The same corpus, the same battery, an oracle blinded to two judged checks. If the number could
  // not fall, 97% would prove only that the corpus was easy.
  it('falls below 95% when the verifier stops finding wrong keys and unsafe content, and the promotion gate blocks the version', async () => {
    await composed.close();
    await composeWith({ blindTo: ['answer_verification', 'safety_appropriateness'] });
    const blinded = await runCorpus();

    expect(blinded.report.catchRate).toBeLessThan(0.95);
    expect(blinded.report.catchRate).toBeCloseTo((95 - 14 - 9) / 100, 10);
    expect(blinded.report.byDefect.wrong_key.caught).toBe(0);
    expect(blinded.report.byDefect.unsafe_content.caught).toBe(0);
    // Structural defects are untouched: they never depended on the oracle.
    expect(blinded.report.structural).toEqual(baseline.report.structural);

    const pin = { modelVersionId: versionId('model', 8003), promptVersionId: versionId('prompt', 8003) };
    await ensureVersions(database.pool, pin, { evaluated: false });
    const passing = expectValue(await handle<unknown, EvaluationRun>('RecordEvaluationRun', { subject: { kind: 'prompt', versionId: PROMPT_VERSION }, corpus: EVAL_CORPUS_VERSION, scores: { verification_catch_rate: baseline.report.catchRate } }, ops));
    const regressed = expectValue(
      await handle<unknown, EvaluationRun>('RecordEvaluationRun', { subject: { kind: 'prompt', versionId: pin.promptVersionId }, corpus: EVAL_CORPUS_VERSION, scores: { verification_catch_rate: blinded.report.catchRate }, baselineRunId: passing.evaluationRunId }, ops),
    );
    expect(regressed.outcome).toBe('fail');
    expect(regressed.regressions).toEqual(['verification_catch_rate']);
  }, 300_000);
});
