import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, aRun, registering } from '../../../../testing/generation-fixtures.js';
import { FIXED_NOW, RecordingAudit, contextFor, fixedClock, principalWith } from '../../../../testing/generation-context.js';
import { PostgresGenerationCandidateRepository } from '../../infrastructure/generation-candidate.repository.js';
import { RecordedProvider } from '../../infrastructure/provider/recorded-provider.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import { PROPOSAL_REQUIRED_KEYS } from '../content-draft-acl.js';
import type { ProposalProvider, ProposalRequest } from '../ports.js';
import { ProposeCandidateHandler } from './propose-handlers.js';

/** Real Postgres and the real recorded adapter — never a double (ENGINEERING-HANDBOOK §5). */
const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), '../../infrastructure/provider/recordings');

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

const machine = principalWith(['generation_pipeline'], 'system');
const RAMP = JSON.parse(readFileSync(join(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as {
  request: { grounding: ProposalRequest['grounding']; task: ProposalRequest['task'] };
  response: { itemType: string; body: Record<string, unknown>; confidence: number };
};
const COMMAND = (runId: string) => ({ runId, grounding: RAMP.request.grounding, task: RAMP.request.task });

async function savedRun() {
  const run = aRun({ modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  expectValue(await runs.save(run));
  return run;
}

function handler(provider: ProposalProvider = RecordedProvider.fromDirectory(RECORDINGS), identifier = () => randomUUID()) {
  const audit = new RecordingAudit();
  return {
    audit,
    propose: new ProposeCandidateHandler({ runs, candidates, provider, clock: fixedClock, identifiers: { next: identifier }, audit }),
  };
}

/** A real adapter loaded with one altered recording of the ramp question: the provider answers, but with a different proposal. */
function providerAnswering(response: Record<string, unknown>): ProposalProvider {
  return RecordedProvider.fromRecordings([{ source: 'altered.json', content: { request: { ...RAMP.request, pin: { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION } }, response } }]);
}

async function candidateCount(): Promise<number> {
  return (await database.pool.query('SELECT count(*)::int AS n FROM ai.generation_candidate')).rows[0].n as number;
}

describe('ProposeCandidate', () => {
  it('creates a proposed candidate with no verdicts, from the recorded proposal, pinned to the run', async () => {
    const run = await savedRun();
    const { propose, audit } = handler();
    const candidate = expectValue(await propose.handle(COMMAND(run.pin.runId), contextFor(machine, 'corr-propose-1')));

    const stored = expectValue(await candidates.findById(candidate.candidateId));
    expect(stored.state).toBe('proposed');
    expect(stored.verdicts).toEqual([]);
    expect(stored.pin.runId).toBe(run.pin.runId);
    expect(stored.pin.modelVersionId).toBe(run.pin.modelVersionId);
    expect(stored.pin.promptVersionId).toBe(run.pin.promptVersionId);
    expect(stored.confidence).toBe(RAMP.response.confidence);
    expect(stored.content.itemType).toBe('SINGLE_CORRECT_MCQ');
    for (const key of PROPOSAL_REQUIRED_KEYS) expect(stored.content.body[key], key).toEqual(RAMP.response.body[key]);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe('ProposeCandidate');
    expect(audit.entries[0]?.targetId).toBe(candidate.candidateId);
    expect(audit.entries[0]?.correlationId).toBe('corr-propose-1');
    expect(audit.entries[0]?.occurredAt).toBe(FIXED_NOW);
  });

  it('takes the candidate id from its own port, and the pin from the stored run — not from the caller or the provider', async () => {
    const run = await savedRun();
    const id = randomUUID();
    const { propose } = handler(undefined, () => id);
    const candidate = expectValue(await propose.handle(COMMAND(run.pin.runId), contextFor(machine)));
    expect(candidate.candidateId).toBe(id);
    expect(candidate.pin).toEqual(run.pin);
  });

  it('is gated to the pipeline: Content Ops, an author and a stranger are refused, and nothing is generated', async () => {
    const run = await savedRun();
    const before = await candidateCount();
    let asked = 0;
    const counting: ProposalProvider = { propose: async (request) => (asked += 1, RecordedProvider.fromDirectory(RECORDINGS).propose(request)) };
    const { propose, audit } = handler(counting);
    for (const roles of [['content_ops'], ['author'], []]) {
      expect(expectError(await propose.handle(COMMAND(run.pin.runId), contextFor(principalWith(roles)))).code).toBe('NOT_PERMITTED');
    }
    expect(asked).toBe(0);
    expect(await candidateCount()).toBe(before);
    expect(audit.entries).toEqual([]);
  });

  it('reports a run that does not exist as NotFound, without asking the provider', async () => {
    let asked = 0;
    const counting: ProposalProvider = { propose: async () => (asked += 1, err(applicationError('Unavailable', 'X', 'x'))) };
    const failure = expectError(await handler(counting).propose.handle(COMMAND(randomUUID()), contextFor(machine)));
    expect(failure.kind).toBe('NotFound');
    expect(asked).toBe(0);
  });

  describe('a proposal that could never become a draft is refused here, naming the key', () => {
    for (const key of PROPOSAL_REQUIRED_KEYS) {
      it(`one without "${key}"`, async () => {
        const run = await savedRun();
        const before = await candidateCount();
        const { [key]: _omitted, ...body } = RAMP.response.body;
        const { propose, audit } = handler(providerAnswering({ ...RAMP.response, body }));

        const failure = expectError(await propose.handle(COMMAND(run.pin.runId), contextFor(machine)));
        expect(failure.kind).toBe('Validation');
        expect(failure.code).toBe('PROPOSAL_FIELD_MISSING');
        expect(failure.location).toBe(`content.body.${key}`);
        expect(await candidateCount()).toBe(before);
        expect(audit.entries).toEqual([]);
      });
    }

    it('one that names no subject', async () => {
      const run = await savedRun();
      const failure = expectError(
        await handler(providerAnswering({ ...RAMP.response, body: { ...RAMP.response.body, subject: '  ' } })).propose.handle(
          COMMAND(run.pin.runId),
          contextFor(machine),
        ),
      );
      expect(failure.location).toBe('content.body.subject');
    });
  });

  it('refuses a confidence the domain refuses, storing nothing', async () => {
    const run = await savedRun();
    const before = await candidateCount();
    const wild: ProposalProvider = { propose: async () => ok({ itemType: 'SINGLE_CORRECT_MCQ', body: RAMP.response.body, confidence: 1.5 }) };
    const failure = expectError(await handler(wild).propose.handle(COMMAND(run.pin.runId), contextFor(machine)));
    expect(failure.code).toBe('CONFIDENCE_OUT_OF_RANGE');
    expect(failure.location).toBe('confidence');
    expect(await candidateCount()).toBe(before);
  });

  it('fails loudly when there is no recording for the question, and stores nothing', async () => {
    const run = await savedRun();
    const before = await candidateCount();
    const { propose, audit } = handler();
    const failure = expectError(await propose.handle({ ...COMMAND(run.pin.runId), task: { unrecorded: true } }, contextFor(machine)));
    expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
    expect(await candidateCount()).toBe(before);
    expect(audit.entries).toEqual([]);
  });

  it('passes a provider’s own failure through unchanged', async () => {
    const run = await savedRun();
    const unavailable = applicationError('Unavailable', 'PROVIDER_DOWN', 'try again later');
    const down: ProposalProvider = { propose: async () => err(unavailable) };
    expect(expectError(await handler(down).propose.handle(COMMAND(run.pin.runId), contextFor(machine)))).toBe(unavailable);
  });

  it('reports an identifier the store already holds as a Conflict', async () => {
    const run = await savedRun();
    const id = randomUUID();
    expectValue(await handler(undefined, () => id).propose.handle(COMMAND(run.pin.runId), contextFor(machine)));
    const other = RAMP.response.body;
    const differing = providerAnswering({ ...RAMP.response, confidence: 0.1, body: other });
    const failure = expectError(await handler(differing, () => id).propose.handle(COMMAND(run.pin.runId), contextFor(machine)));
    expect(failure.kind).toBe('Conflict');
  });
});
