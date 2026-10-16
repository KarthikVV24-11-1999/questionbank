import { randomUUID } from 'node:crypto';
import type { GenerationRunRepository } from '../../contexts/generation/domain/repository-ports.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkGenerationIsDownstreamOnly,
  checkGenerationReachesUpstreamOnlyAsBarrelTypes,
  checkGenerationTouchesNoContentTable,
} from '../../fitness/generation-rules.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { singleCorrectSpec, textBody } from '../../testing/content-fixtures.js';
import { contentAuthoringOver } from '../../testing/content-authoring-adapter.js';
import { aRun, registering, MODEL_VERSION, PROMPT_VERSION, ensureVersions } from '../../testing/generation-fixtures.js';
import { contextFor, fixedClock, principalWith, RecordingAudit } from '../../testing/generation-context.js';
import { readFileSync } from 'node:fs';
import { composeGenerationHandlers } from '../../contexts/generation/application/compose-handlers.js';
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';
import { AcceptCandidateHandler } from '../../contexts/generation/application/handlers/decision-handlers.js';
import { createGenerationCandidate, recordVerdict, type GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { BLOCKING_PRECHECKS } from '../../contexts/generation/domain/precheck-vocabulary.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';

/**
 * An accepted candidate becomes a draft in content's review queue — end to end,
 * against real Postgres and **content's real handlers**, so the mapping is
 * proved against the invariants it exists to satisfy (F27, SEC-20, INV-01).
 *
 * Lives in the composition tree because it is the one place both contexts may
 * be named together; neither context's own tree may do so.
 */
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let database: TestDatabase;
let runs: GenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;
let authoring: ReturnType<typeof contentAuthoringOver>;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
  authoring = contentAuthoringOver(database.pool, {
    clock: fixedClock,
    identifiers: { next: () => randomUUID() },
    renderer: { async validate(version) { return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] }; } },
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const ops = principalWith(['content_ops']);

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [{ conceptIdentityId: randomUUID(), taxonomyVersionId: randomUUID(), weight: 1, isPrimary: true }],
    difficultyEstimate: 'moderate',
    subject: 'physics',
    licensing: { status: 'owned' },
    ...overrides,
  };
}

async function storedCandidate(body: Record<string, unknown>, confidence = 0.64): Promise<GenerationCandidate> {
  const run = aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });
  expectValue(await runs.save(run));
  let candidate = expectValue(
    createGenerationCandidate({
      candidateId: randomUUID(),
      pin: run.pin,
      content: { itemType: 'SINGLE_CORRECT_MCQ', body },
      confidence,
      verdicts: [],
    }),
  );
  for (const check of BLOCKING_PRECHECKS) candidate = expectValue(recordVerdict(candidate, { check, outcome: 'pass' }));
  expectValue(await candidates.save(candidate));
  return candidate;
}

function accept() {
  const audit = new RecordingAudit();
  return new AcceptCandidateHandler({ candidates, content: authoring, clock: fixedClock, audit });
}

async function contentRowCount(table: string): Promise<number> {
  return (await database.pool.query(`SELECT count(*)::int AS n FROM content.${table}`)).rows[0].n as number;
}

describe('an accepted candidate becomes a draft in the review queue', () => {
  it('queues the draft for review, carrying the candidate’s pin and confidence as AI provenance', async () => {
    const candidate = await storedCandidate(proposal());
    const accepted = expectValue(await accept().handle({ candidateId: candidate.candidateId }, contextFor(ops, 'corr-e2e-1')));

    const item = expectValue(await authoring.items.findById(accepted.contentItemId));
    expect(item.lifecycleState).toBe('in_review');
    expect(item.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(item.versions).toHaveLength(1);

    // Field by field, against values chosen to be distinct from one another so
    // a swapped pair of fields cannot hide behind equal ones.
    const provenance = item.versions[0]!.provenance;
    expect(provenance.sourceType).toBe('ai_generated');
    expect(provenance.modelVersionId).toBe(candidate.pin.modelVersionId);
    expect(provenance.promptVersionId).toBe(candidate.pin.promptVersionId);
    expect(provenance.generationRunId).toBe(candidate.pin.runId);
    expect(provenance.confidence).toBe(0.64);
    expect(new Set([provenance.modelVersionId, provenance.promptVersionId, provenance.generationRunId]).size).toBe(3);
    expect(item.versions[0]!.authoredBy.id).toBe(ops.id);

    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('accepted');
    const { rows } = await database.pool.query(`SELECT payload FROM platform.outbox_message WHERE aggregate_id = $1`, [candidate.candidateId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.contentItemId).toBe(accepted.contentItemId);
  });

  it('is the same queue a human author’s draft joins: the item is an ordinary content item awaiting a human', async () => {
    const candidate = await storedCandidate(proposal());
    const accepted = expectValue(await accept().handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    const { rows } = await database.pool.query(`SELECT lifecycle_state FROM content.item WHERE item_id = $1`, [accepted.contentItemId]);
    expect(rows).toEqual([{ lifecycle_state: 'in_review' }]);
    // Not published, and not publishable by this path: INV-01 leaves that to a human reviewer's signature.
    expect(item(rows)).not.toBe('published');
  });

  it('writes nothing in content when generation refuses first', async () => {
    const before = await contentRowCount('item');
    const unchecked = expectValue(
      createGenerationCandidate({
        candidateId: randomUUID(),
        pin: aRun().pin,
        content: { itemType: 'SINGLE_CORRECT_MCQ', body: proposal() },
        confidence: 0.5,
        verdicts: [],
      }),
    );
    const run = aRun();
    expectValue(await runs.save(run));
    expectValue(await candidates.save({ ...unchecked, pin: run.pin }));
    const failure = expectError(await accept().handle({ candidateId: unchecked.candidateId }, contextFor(ops)));
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    expect(await contentRowCount('item')).toBe(before);
  });

  it('stores the confidence content would store, so provenance reads back as the mapping said', async () => {
    const candidate = await storedCandidate(proposal(), 0.64149);
    const accepted = expectValue(await accept().handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    const item = expectValue(await authoring.items.findById(accepted.contentItemId));
    expect(item.versions[0]!.provenance.confidence).toBe(0.641);
    expect(expectValue(await candidates.findById(candidate.candidateId)).confidence).toBe(0.64149);
  });

  it('contains content raising on a malformed proposal: the candidate stays proposed and content is empty', async () => {
    const before = await contentRowCount('item');
    const candidate = await storedCandidate(proposal({ responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' } }));

    const failure = expectError(await accept().handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    expect(failure.code).toBe('CONTENT_AUTHORING_FAILED');
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
    expect(await contentRowCount('item')).toBe(before);
    expect((await database.pool.query(`SELECT 1 FROM platform.outbox_message WHERE aggregate_id = $1`, [candidate.candidateId])).rowCount).toBe(0);
  });

  it('is refused by content for a principal content does not admit, without the candidate moving', async () => {
    const candidate = await storedCandidate(proposal());
    // Generation admits Content Ops only; this shows the content half too, by
    // handing the same command to content directly under a role it refuses.
    const outsider = principalWith(['content_ops']);
    const refusing = contextFor({ ...outsider, roleContext: ['learner'] });
    expect(expectError(await accept().handle({ candidateId: candidate.candidateId }, refusing)).code).toBe('NOT_PERMITTED');
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });
});

function item(rows: { lifecycle_state: string }[]): string {
  return rows[0]!.lifecycle_state;
}

describe('ADR-0025 stays green throughout — asserted, not assumed', () => {
  it('nothing in content points at generation', () => {
    expect(checkGenerationIsDownstreamOnly(API_ROOT)).toEqual([]);
  });

  it('generation names no content table, so every write in content is content’s own handler’s (F27)', () => {
    expect(checkGenerationTouchesNoContentTable(API_ROOT)).toEqual([]);
  });

  it('generation reaches content only through its barrel, and only for types', () => {
    expect(checkGenerationReachesUpstreamOnlyAsBarrelTypes(API_ROOT)).toEqual([]);
  });
});

describe('the whole pipeline: start a run, propose, check, accept — a draft in content’s review queue', () => {
  const RECORDINGS = resolve(API_ROOT, 'src/contexts/generation/infrastructure/provider/recordings');
  const machine = principalWith(['generation_pipeline'], 'system');

  it('carries a recorded proposal through every handler of both contexts, composed through the real registry', async () => {
    await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
    const registry = composeGenerationHandlers({
      runs,
      candidates,
      clock: fixedClock,
      identifiers: { next: () => randomUUID() },
      audit: new RecordingAudit(),
      provider: RecordedProvider.fromDirectory(RECORDINGS),
      runners: [],
      blocked: [],
      content: authoring,
    });
    const run = <I, O>(name: string, input: I, principal = machine) => {
      const found = registry.get<I, O>(name);
      if (found === undefined) throw new Error(`no handler ${name}`);
      return found.handle(input, contextFor(principal, 'corr-pipeline'));
    };
    const recorded = JSON.parse(readFileSync(resolve(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as {
      request: { grounding: never; task: Record<string, unknown> };
      response: { confidence: number };
    };

    const started = expectValue(
      await run<unknown, { pin: { runId: string } }>('StartGenerationRun', {
        modelVersionId: MODEL_VERSION,
        promptVersionId: PROMPT_VERSION,
        request: recorded.request.task,
      }),
    );
    const proposed = expectValue(
      await run<unknown, GenerationCandidate>('ProposeCandidate', {
        runId: started.pin.runId,
        grounding: recorded.request.grounding,
        task: recorded.request.task,
      }),
    );
    expect(proposed.state).toBe('proposed');
    expect(proposed.verdicts).toEqual([]);

    // Accepting before any check is refused, by generation, before content is touched.
    const before = await contentRowCount('item');
    expect(expectError(await run('AcceptCandidate', { candidateId: proposed.candidateId }, ops)).code).toBe('CANDIDATE_NOT_PRECHECKED');
    expect(await contentRowCount('item')).toBe(before);

    for (const check of BLOCKING_PRECHECKS) {
      expectValue(await run('RecordPrecheckVerdict', { candidateId: proposed.candidateId, check, outcome: 'pass' }));
    }

    const accepted = expectValue(await run<unknown, { contentItemId: string }>('AcceptCandidate', { candidateId: proposed.candidateId }, ops));

    const item = expectValue(await authoring.items.findById(accepted.contentItemId));
    expect(item.lifecycleState).toBe('in_review');
    const provenance = item.versions[0]!.provenance;
    expect(provenance.sourceType).toBe('ai_generated');
    expect(provenance.modelVersionId).toBe(MODEL_VERSION);
    expect(provenance.promptVersionId).toBe(PROMPT_VERSION);
    expect(provenance.generationRunId).toBe(started.pin.runId);
    expect(provenance.confidence).toBe(recorded.response.confidence);
    expect(expectValue(await candidates.findById(proposed.candidateId)).state).toBe('accepted');
  });
});
