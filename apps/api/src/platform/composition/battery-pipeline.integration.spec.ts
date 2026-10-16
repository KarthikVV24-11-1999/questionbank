import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetTaxonomyVersionQuery } from '../../contexts/curriculum/application/queries/curriculum-queries.js';
import { composeGenerationHandlers } from '../../contexts/generation/application/compose-handlers.js';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import { buildPrechecks } from '../../contexts/generation/application/prechecks/index.js';
import type { PrecheckConfig } from '../../contexts/generation/application/prechecks/judge.js';
import type { HandlerRegistry } from '../../contexts/generation/application/handler-registry.js';
import type { GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { CurriculumSyllabusReader } from '../../contexts/generation/infrastructure/curriculum-syllabus-reader.js';
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';
import { PostgresVersionRegistry } from '../../contexts/generation/infrastructure/version-registry.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import { contentAuthoringOver } from '../../testing/content-authoring-adapter.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, ensureVersions, registering, versionId } from '../../testing/generation-fixtures.js';
import { RecordingAudit, contextFor, fixedClock, principalWith } from '../../testing/generation-context.js';
import { aTaxonomy } from '../../testing/published-taxonomy.js';

/**
 * The whole pre-check battery, end to end: a recorded proposal, the real
 * registry, curriculum's real taxonomy, content's real handlers, real Postgres.
 *
 * The point is what it adds up to. Seven checks can run, five cannot (content
 * exposes no validator over a proposal), and a candidate whose blocking checks
 * did not all run **cannot be accepted** — said here as a fact about the running
 * system, because "a check that did not run is not a check that passed" is only
 * worth anything if acceptance really does refuse.
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

let database: TestDatabase;
let candidates: PostgresGenerationCandidateRepository;
let registry: HandlerRegistry;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  await aTaxonomy(database, { versionId: RAMP_TAG.taxonomyVersionId, conceptIdentityId: RAMP_TAG.conceptIdentityId, displayName: 'Kinematics', publish: true });

  candidates = new PostgresGenerationCandidateRepository(database.pool);
  const provider = RecordedProvider.fromDirectory(RECORDINGS);
  const syllabus = new CurriculumSyllabusReader(
    new GetTaxonomyVersionQuery({ versions: new DrizzleTaxonomyVersionRepository(database.db), exams: {} as never, profiles: {} as never, migrations: {} as never }),
  );
  registry = composeGenerationHandlers({
    runs: registering(database.pool),
    candidates,
    clock: fixedClock,
    identifiers: { next: () => randomUUID() },
    audit: new RecordingAudit(),
    provider,
    content: contentAuthoringOver(database.pool, {
      clock: fixedClock,
      identifiers: { next: () => randomUUID() },
      renderer: { async validate(version) { return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] }; } },
    }),
    ...buildPrechecks({ registry: new PostgresVersionRegistry(database.pool), judge: provider, syllabus, config: CONFIG }),
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const machine = principalWith(['generation_pipeline'], 'system');
const machineWhoMayReadTheSyllabus = principalWith(['generation_pipeline', 'content_ops'], 'system');
const ops = principalWith(['content_ops']);

function handle<I, O>(name: string, input: I, principal = machine) {
  const found = registry.get<I, O>(name);
  if (found === undefined) throw new Error(`no handler ${name}`);
  return found.handle(input, contextFor(principal, 'corr-battery-e2e'));
}

async function proposed(proposal: string): Promise<GenerationCandidate> {
  const { grounding, task } = TASK(proposal);
  const run = expectValue(await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: task }));
  return expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
}

const statusOf = (report: BatteryReport, check: string) => report.checks.find((line) => line.check === check)!;
const countOf = async (table: string): Promise<number> => (await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

describe('the battery, as it runs today', () => {
  it('records what ran, leaves what could not, and reports every one of the twelve', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    expect(report.checks).toHaveLength(12);
    const byStatus = (status: string) => report.checks.filter((line) => line.status === status).map((line) => line.check).sort();
    expect(byStatus('recorded')).toEqual(
      ['ambiguity_clarity', 'answer_verification', 'distractor_validity', 'item_solution_key_consistency', 'provenance_licensing_completeness', 'safety_appropriateness'],
    );
    expect(byStatus('blocked')).toEqual(['difficulty_plausibility', 'duplicate_detection', 'numeric_spec_completeness', 'renderability', 'schema_validity']);
    expect(byStatus('could_not_run')).toEqual(['syllabus_scope']);
    expect(byStatus('unaccounted')).toEqual([]);
    expect(byStatus('could_not_record')).toEqual([]);
  });

  it('says plainly what each blocked check is blocked on', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    for (const check of ['schema_validity', 'renderability', 'numeric_spec_completeness', 'duplicate_detection', 'difficulty_plausibility']) {
      const line = statusOf(report, check);
      expect(line.status).toBe('blocked');
      expect(line.blocked?.successor).toContain('pure validator over proposed content');
      expect(line.blocked?.successor).toContain('duplicate check that accepts proposed content');
    }
  });

  it('records no verdict at all for a blocked check or for one that could not run — not a pass, not a skip', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const { rows } = await database.pool.query(`SELECT check_id FROM ai.candidate_verdict WHERE candidate_id = $1 ORDER BY check_id`, [candidate.candidateId]);
    expect(rows.map((row: { check_id: string }) => row.check_id)).toEqual([
      'ambiguity_clarity', 'answer_verification', 'distractor_validity', 'item_solution_key_consistency', 'provenance_licensing_completeness', 'safety_appropriateness',
    ]);
  });

  it('records the working with each verdict, so a reviewer sees why', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    const stored = expectValue(await candidates.findById(candidate.candidateId));
    for (const verdict of stored.verdicts) {
      expect(verdict.outcome, verdict.check).toBe('pass');
      expect((verdict.detail ?? '').length, verdict.check).toBeGreaterThan(30);
    }
    expect(stored.verdicts.find((verdict) => verdict.check === 'answer_verification')?.detail).toContain('solve 1 answered "b"');
  });

  it('is idempotent: a second run runs nothing again and writes nothing', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    const second = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    expect(second.checks.filter((line) => line.status === 'already_recorded')).toHaveLength(6);
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toHaveLength(6);
  });
});

describe('a check that did not run is not a check that passed — end to end', () => {
  async function acceptance(candidate: GenerationCandidate) {
    const items = await countOf('content.item');
    const failure = expectError(await handle('AcceptCandidate', { candidateId: candidate.candidateId }, ops));
    expect(await countOf('content.item')).toBe(items);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
    return failure;
  }

  it('acceptance still refuses after every check that can run has passed, naming each blocking check that never did', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const failure = await acceptance(candidate);
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    for (const missing of ['schema_validity', 'renderability', 'numeric_spec_completeness', 'syllabus_scope']) {
      expect(failure.message, missing).toContain(missing);
    }
    for (const ran of ['answer_verification', 'item_solution_key_consistency', 'distractor_validity', 'safety_appropriateness', 'provenance_licensing_completeness']) {
      expect(failure.message, ran).not.toContain(ran);
    }
  });

  it('and still refuses when the syllabus check runs too — the three content-blocked checks remain', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, machineWhoMayReadTheSyllabus));
    expect(statusOf(report, 'syllabus_scope')).toMatchObject({ status: 'recorded', outcome: 'pass' });

    const failure = await acceptance(candidate);
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    expect(failure.message).toContain('schema_validity');
    expect(failure.message).not.toContain('syllabus_scope');
  });

  it('a candidate the model could not stand behind is a failing verdict, and acceptance names the check that failed', async () => {
    const candidate = await proposed('optics-lens.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const verification = statusOf(report, 'answer_verification');
    expect(verification).toMatchObject({ status: 'recorded', outcome: 'fail' });
    expect(verification.detail).toContain('solve 1 answered "c"');
    expect(verification.detail).toContain('solve 2 answered "a"');
    // Advisory: the ambiguity check also said no, and that alone would not block.
    expect(statusOf(report, 'ambiguity_clarity')).toMatchObject({ status: 'recorded', outcome: 'fail', severity: 'advisory' });
    // No solution in this proposal, so consistency could not run.
    expect(statusOf(report, 'item_solution_key_consistency')).toMatchObject({ status: 'could_not_run', error: { code: 'PROPOSAL_UNREADABLE' } });

    const failure = await acceptance(candidate);
    expect(failure.code).toBe('CANDIDATE_PRECHECK_FAILED');
    expect(failure.message).toContain('answer_verification');
    expect(failure.message).not.toContain('ambiguity_clarity');
  });

  it('and never escalates: the candidate has no state a reviewer’s queue reads', async () => {
    const candidate = await proposed('optics-lens.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    // Still `proposed`, with no decision row and no outbox event: nothing was routed anywhere.
    expect(await countOf(`ai.candidate_decision WHERE candidate_id = '${candidate.candidateId}'`)).toBe(0);
    expect(await countOf(`platform.outbox_message WHERE aggregate_id = '${candidate.candidateId}'`)).toBe(0);
  });
});
