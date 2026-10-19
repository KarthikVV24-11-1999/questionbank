import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import type { PrecheckConfig } from '../../contexts/generation/application/prechecks/judge.js';
import type { HandlerRegistry } from '../../contexts/generation/application/handler-registry.js';
import type { GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';
import { PostgresFingerprintRepository } from '../../contexts/content/infrastructure/review/fingerprint.repository.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, aCandidate, ensureVersions, versionId } from '../../testing/generation-fixtures.js';
import { composeGeneration, type ComposedGeneration } from '../../testing/composed-generation.js';
import { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
import { contextFor, fixedClock, principalWith } from '../../testing/generation-context.js';
import { RefreshFingerprintsHandler } from '../../contexts/content/application/review/handlers/fingerprint-handlers.js';
import { aTaxonomy } from '../../testing/published-taxonomy.js';

/**
 * The whole pre-check battery, end to end: a recorded proposal, the real
 * registry, curriculum's real taxonomy, content's real handlers, real Postgres.
 *
 * The point is what it adds up to. Eleven checks can run and one cannot (the
 * difficulty prior, advisory), and a candidate whose blocking checks did not all
 * run **cannot be accepted** while one that ran them all and passed **is**, and
 * reaches content's review queue — said here as facts about the running system,
 * because "a check that did not run is not a check that passed" is only worth
 * anything if acceptance really does refuse, and the milestone's deliverable is
 * only demonstrated if it really does accept.
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
let composed: ComposedGeneration;
let candidates: PostgresGenerationCandidateRepository;
let registry: HandlerRegistry;
let fingerprints: PostgresFingerprintRepository;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  await aTaxonomy(database, { versionId: RAMP_TAG.taxonomyVersionId, conceptIdentityId: RAMP_TAG.conceptIdentityId, displayName: 'Kinematics', publish: true });

  // The application as it is composed: the real registry, content's and curriculum's real
  // handlers behind it, the real audit recorder in front. Only the provider is a test's, because
  // no live adapter exists.
  composed = await composeGeneration(database, { provider: RecordedProvider.fromDirectory(RECORDINGS), precheckConfig: CONFIG });
  registry = composed.registry;
  candidates = new PostgresGenerationCandidateRepository(database.pool);
  fingerprints = new PostgresFingerprintRepository(database.pool);
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await composed.close();
  await database.revertMigrations();
  await database.close();
});

/**
 * The pipeline's token carries the subject it generates for. Disposing creates a draft through
 * content's own handler, and content scopes authoring by subject (FR-TCH-01 rule 1) — a pipeline
 * with no scope is refused there rather than given a cross-subject reach that only Content Ops has.
 */
const machine = principalWith(['generation_pipeline', 'subject:physics'], 'system');
const ops = principalWith(['content_ops']);

function handle<I, O>(name: string, input: I, principal = machine) {
  const found = registry.get<I, O>(name);
  if (found === undefined) throw new Error(`no handler ${name}`);
  return found.handle(input, contextFor(principal, 'corr-battery-e2e'));
}

async function proposed(proposal: string): Promise<GenerationCandidate> {
  const { grounding, task } = TASK(proposal);
  const run = expectValue(await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: task, budgetTokens: 100_000 }));
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
    expect(byStatus('recorded')).toEqual([
      'ambiguity_clarity', 'answer_verification', 'distractor_validity', 'duplicate_detection', 'item_solution_key_consistency',
      'numeric_spec_completeness', 'provenance_licensing_completeness', 'renderability', 'safety_appropriateness', 'schema_validity', 'syllabus_scope',
    ]);
    expect(byStatus('blocked')).toEqual(['difficulty_plausibility']);
    expect(byStatus('could_not_run')).toEqual([]);
    expect(byStatus('unaccounted')).toEqual([]);
    expect(byStatus('could_not_record')).toEqual([]);
  });

  it('says plainly what the one blocked check is blocked on', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    const line = statusOf(report, 'difficulty_plausibility');
    expect(line.status).toBe('blocked');
    expect(line.severity).toBe('advisory');
    expect(line.blocked?.successor).toContain('difficulty prior over proposed content');
  });

  it('records no verdict at all for a blocked check or for one that could not run — not a pass, not a skip', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const { rows } = await database.pool.query(`SELECT check_id FROM ai.candidate_verdict WHERE candidate_id = $1 ORDER BY check_id`, [candidate.candidateId]);
    expect(rows.map((row: { check_id: string }) => row.check_id)).toEqual([
      'ambiguity_clarity', 'answer_verification', 'distractor_validity', 'duplicate_detection', 'item_solution_key_consistency',
      'numeric_spec_completeness', 'provenance_licensing_completeness', 'renderability', 'safety_appropriateness', 'schema_validity', 'syllabus_scope',
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

  it('is idempotent: a second run runs nothing again, writes nothing, and picks the disposition up where the first left it', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    // The first run's disposition fails (no subject scope), leaving the candidate proposed with its verdicts.
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }, principalWith(['generation_pipeline'], 'system')));
    const second = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    expect(second.checks.filter((line) => line.status === 'already_recorded')).toHaveLength(11);
    expect(second.disposition.status).toBe('accepted');
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toHaveLength(11);
  });

  it('refuses a candidate that has already been disposed of: a run after the decision is not a second chance at a draft', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    const before = await countOf('content.item');
    expect(expectError(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId })).code).toBe('VERDICT_CANDIDATE_NOT_PROPOSED');
    expect(await countOf('content.item')).toBe(before);
  });
});

describe('a candidate generated by the pipeline reaches content’s review queue — end to end (M5-40, ADR-0029)', () => {
  /** What became of a candidate the battery rejected: terminal, no draft, and not acceptable by anyone. */
  async function rejectedWithNoDraft(candidate: GenerationCandidate, items: number) {
    expect(await countOf('content.item')).toBe(items);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('rejected');
    // Terminal: even the operator's override cannot take it back.
    const override = expectError(await handle('AcceptCandidate', { candidateId: candidate.candidateId }, ops));
    expect(override.code).toBe('TRANSITION_ILLEGAL');
    expect(await countOf('content.item')).toBe(items);
  }

  // Track E proved the opposite: with checks 1, 2 and 4 blocked, nothing could be
  // accepted. This is the milestone's deployable outcome, demonstrated, with no human
  // between the proposal and the review queue.
  it('proposed, checked by every blocking check, and accepted by the pipeline — a draft awaiting a human reviewer', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const before = await countOf('content.item');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, machine));
    expect(report.checks.filter((line) => line.status === 'recorded' && line.outcome === 'pass')).toHaveLength(11);

    expect(report.disposition.status).toBe('accepted');
    const contentItemId = (report.disposition as { contentItemId: string }).contentItemId;
    expect(await countOf('content.item')).toBe(before + 1);
    const queued = await database.pool.query(`SELECT lifecycle_state FROM content.item WHERE item_id = $1`, [contentItemId]);
    expect(queued.rows).toEqual([{ lifecycle_state: 'in_review' }]);
    const provenance = await database.pool.query(
      `SELECT source_type, model_version_id, prompt_version_id, generation_run_id FROM content.item_provenance p
         JOIN content.item_version v USING (item_version_id) WHERE v.item_id = $1`,
      [contentItemId],
    );
    expect(provenance.rows).toEqual([
      { source_type: 'ai_generated', model_version_id: candidate.pin.modelVersionId, prompt_version_id: candidate.pin.promptVersionId, generation_run_id: candidate.pin.runId },
    ]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('accepted');
    expect(await countOf(`platform.outbox_message WHERE aggregate_id = '${candidate.candidateId}'`)).toBe(1);
  });

  it('and is not published: INV-01 leaves that to a human reviewer’s signature — F27 and F33 as a fact about the running system', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, machine));
    const contentItemId = (report.disposition as { contentItemId: string }).contentItemId;
    const published = await database.pool.query(`SELECT 1 FROM content.item WHERE item_id = $1 AND lifecycle_state = 'published'`, [contentItemId]);
    expect(published.rowCount).toBe(0);
    // Nothing the pipeline did published anything, or approved anything: no review decision row names the item.
    const decisions = await database.pool.query(`SELECT 1 FROM content.review_decision d JOIN content.item_version v ON v.item_version_id = d.owner_version_id WHERE v.item_id = $1`, [contentItemId]);
    expect(decisions.rowCount).toBe(0);
  });

  it('is the pipeline’s own principal alone — no borrowed role — that takes the candidate into the queue (D43 closed)', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, principalWith(['generation_pipeline', 'subject:physics'], 'system')));
    expect(statusOf(report, 'syllabus_scope')).toMatchObject({ status: 'recorded', outcome: 'pass' });
    expect(report.disposition.status).toBe('accepted');
  });

  it('fails closed without a subject scope: content refuses the draft, the verdicts stand, and nothing is half-made', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const before = await countOf('content.item');
    const unscoped = principalWith(['generation_pipeline'], 'system');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, unscoped));

    expect(report.disposition).toMatchObject({ status: 'failed', error: { code: expect.stringMatching(/SUBJECT/u) } });
    expect(await countOf('content.item')).toBe(before);
    const stored = expectValue(await candidates.findById(candidate.candidateId));
    expect(stored.state).toBe('proposed');
    expect(stored.verdicts).toHaveLength(11);
  });

  it('does not reach into another subject: a pipeline scoped to chemistry cannot put a physics draft into the queue', async () => {
    const candidate = await proposed('kinematics-ramp.json');
    const before = await countOf('content.item');
    const chemistry = principalWith(['generation_pipeline', 'subject:chemistry'], 'system');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }, chemistry));
    expect(report.disposition.status).toBe('failed');
    expect(await countOf('content.item')).toBe(before);
  });

  it('a proposal tagged with a concept the syllabus does not hold fails check 5, and is rejected for it', async () => {
    const candidate = await proposed('optics-lens.json');
    const before = await countOf('content.item');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    expect(statusOf(report, 'syllabus_scope')).toMatchObject({ status: 'recorded', outcome: 'fail' });
    expect(statusOf(report, 'syllabus_scope').detail).toContain('is not in taxonomy version');
    expect(report.disposition).toEqual({ status: 'rejected' });
    await rejectedWithNoDraft(candidate, before);
  });

  it('a candidate the model could not stand behind is a failing verdict, and is rejected with the check that failed on the record', async () => {
    const candidate = await proposed('optics-lens.json');
    const before = await countOf('content.item');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: candidate.candidateId }));

    const verification = statusOf(report, 'answer_verification');
    expect(verification).toMatchObject({ status: 'recorded', outcome: 'fail' });
    expect(verification.detail).toContain('solve 1 answered "c"');
    expect(verification.detail).toContain('solve 2 answered "a"');
    // Advisory: the ambiguity check also said no, and that alone would not block.
    expect(statusOf(report, 'ambiguity_clarity')).toMatchObject({ status: 'recorded', outcome: 'fail', severity: 'advisory' });
    // No solution in this proposal, so consistency could not run.
    expect(statusOf(report, 'item_solution_key_consistency')).toMatchObject({ status: 'could_not_run', error: { code: 'PROPOSAL_UNREADABLE' } });

    // Rejected on the check that failed, though another blocking check never ran: a failure settles it.
    expect(report.disposition).toEqual({ status: 'rejected' });
    await rejectedWithNoDraft(candidate, before);
    const stored = expectValue(await candidates.findById(candidate.candidateId));
    expect(stored.verdicts.find((verdict) => verdict.check === 'answer_verification')).toMatchObject({ outcome: 'fail' });
  });

  it('writes a rejection and nothing else: one event, no draft, nothing routed to a reviewer', async () => {
    const candidate = await proposed('optics-lens.json');
    expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }));
    const events = await database.pool.query(`SELECT event_type FROM platform.outbox_message WHERE aggregate_id = $1`, [candidate.candidateId]);
    expect(events.rows).toEqual([{ event_type: 'CandidateRejected' }]);
  });
});

describe('what content says about a proposal is acted on — end to end, by content’s own rules', () => {
  const UNRENDERABLE_BODY = (() => {
    const ramp = JSON.parse(readFileSync(join(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as { response: { body: Record<string, unknown> } };
    return {
      ...ramp.response.body,
      stem: { schemaVersion: 1, blocks: [{ kind: 'MATH_BLOCK', latex: '\\wormhole', textAlternative: 'a wormhole' }] },
    };
  })();

  it('a stem that does not render is recorded as failing renderability, and the candidate is rejected for it', async () => {
    const run = expectValue(await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: {}, budgetTokens: 100_000 }));
    const stored = aCandidate(
      { pin: { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, runId: run.pin.runId }, requestedAt: '2026-10-16T09:30:00.000Z', request: {}, budgetTokens: 100_000 },
      { body: UNRENDERABLE_BODY },
    );
    expectValue(await candidates.save(stored));

    const items = await countOf('content.item');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: stored.candidateId }, machine));
    expect(statusOf(report, 'renderability')).toMatchObject({ status: 'recorded', outcome: 'fail', severity: 'blocking' });
    expect(statusOf(report, 'renderability').detail).toContain('NOTATION_UNRENDERABLE');
    expect(statusOf(report, 'schema_validity')).toMatchObject({ status: 'recorded', outcome: 'pass' });

    expect(report.disposition).toEqual({ status: 'rejected' });
    expect(expectValue(await candidates.findById(stored.candidateId)).state).toBe('rejected');
    expect(await countOf('content.item')).toBe(items);
  });

  it('a retype of something already in the review queue is flagged, and — being advisory — does not stop the pipeline accepting it', async () => {
    const first = await proposed('kinematics-ramp.json');
    const firstReport = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: first.candidateId }, machine));
    const queued = { contentItemId: (firstReport.disposition as { contentItemId: string }).contentItemId };
    expectValue(await new RefreshFingerprintsHandler({ items, fingerprints }).handle({ since: '2000-01-01T00:00:00.000Z', now: '2026-10-16T09:30:00.000Z' }, contextFor(ops)));

    const again = await proposed('kinematics-ramp.json');
    const report = expectValue(await handle<unknown, BatteryReport>('RunPrecheckBattery', { candidateId: again.candidateId }, machine));
    const duplicate = statusOf(report, 'duplicate_detection');
    expect(duplicate).toMatchObject({ status: 'recorded', outcome: 'fail', severity: 'advisory' });
    expect(duplicate.detail).toContain('exact retype of');

    expect(report.disposition.status).toBe('accepted');
    expect((report.disposition as { contentItemId: string }).contentItemId).not.toBe(queued.contentItemId);
  });
});

describe('a run’s candidate list leaves out the one that failed a blocking check (M5-39)', () => {
  it('lists the candidate that passed and not the one the real battery failed, though both belong to the run', async () => {
    const recorded = (name: string) => TASK(name);
    const run = expectValue(
      await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { purpose: 'listing' }, budgetTokens: 100_000 }),
    );
    const propose = async (name: string) => {
      const { grounding, task } = recorded(name);
      return expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    };
    const good = await propose('kinematics-ramp.json');
    const bad = await propose('optics-lens.json');
    for (const candidate of [good, bad]) expectValue(await handle('RunPrecheckBattery', { candidateId: candidate.candidateId }, machine));

    // The premise, read from storage and not assumed: one failed a blocking check, the other passed them all.
    const failedBlocking = (candidate: GenerationCandidate) => candidate.verdicts.filter((verdict) => verdict.outcome === 'fail' && ['answer_verification', 'syllabus_scope'].includes(verdict.check));
    expect(failedBlocking(expectValue(await candidates.findById(bad.candidateId))).length).toBeGreaterThan(0);
    expect(failedBlocking(expectValue(await candidates.findById(good.candidateId)))).toEqual([]);
    // D46 closed: the one that failed is rejected, terminally, and the one that passed is already a draft.
    expect(expectValue(await candidates.findById(bad.candidateId)).state).toBe('rejected');
    expect(expectValue(await candidates.findById(good.candidateId)).state).toBe('accepted');

    const listed = expectValue(await handle<unknown, GenerationCandidate[]>('ListRunCandidates', { runId: run.pin.runId }, ops));
    expect(listed.map((candidate) => candidate.candidateId)).toEqual([good.candidateId]);
    expect(expectValue(await candidates.findByRun(run.pin.runId))).toHaveLength(2);
  });

  it('still returns the failed candidate by id, with the working that failed it', async () => {
    const run = expectValue(
      await handle<unknown, { pin: { runId: string } }>('StartGenerationRun', { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { purpose: 'read-by-id' }, budgetTokens: 100_000 }),
    );
    const { grounding, task } = TASK('optics-lens.json');
    const bad = expectValue(await handle<unknown, GenerationCandidate>('ProposeCandidate', { runId: run.pin.runId, grounding, task }));
    expectValue(await handle('RunPrecheckBattery', { candidateId: bad.candidateId }));

    const read = expectValue(await handle<unknown, GenerationCandidate>('GetCandidate', { candidateId: bad.candidateId }, ops));
    expect(read.verdicts.find((verdict) => verdict.check === 'answer_verification')).toMatchObject({ outcome: 'fail' });
    expect(expectValue(await handle<unknown, GenerationCandidate[]>('ListRunCandidates', { runId: run.pin.runId }, ops))).toEqual([]);
  });
});
