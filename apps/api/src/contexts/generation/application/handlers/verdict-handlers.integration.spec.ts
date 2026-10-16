import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun } from '../../../../testing/generation-fixtures.js';
import { FIXED_NOW, RecordingAudit, contextFor, fixedClock, principalWith } from '../../../../testing/generation-context.js';
import { PostgresGenerationCandidateRepository } from '../../infrastructure/generation-candidate.repository.js';
import { PostgresGenerationRunRepository } from '../../infrastructure/generation-run.repository.js';
import { acceptCandidate, recordVerdict, rejectCandidate, type GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import { BLOCKING_PRECHECKS, PRECHECK_IDS } from '../../domain/precheck-vocabulary.js';
import { RecordPrecheckVerdictHandler } from './verdict-handlers.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let runs: PostgresGenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = new PostgresGenerationRunRepository(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const pipeline = principalWith(['generation_pipeline'], 'system');

async function stored(): Promise<GenerationCandidate> {
  const run = aRun();
  expectValue(await runs.save(run));
  const candidate = aCandidate(run);
  expectValue(await candidates.save(candidate));
  return candidate;
}

/** Counts reads and writes while delegating every one to the real repository — it observes, it does not stand in. */
function observed(): { repository: GenerationCandidateRepository; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    repository: {
      save: (...args) => (calls.push('save'), candidates.save(...args)),
      findById: (id) => (calls.push('findById'), candidates.findById(id)),
      findByRun: (id) => (calls.push('findByRun'), candidates.findByRun(id)),
      findByPromptVersion: (id) => (calls.push('findByPromptVersion'), candidates.findByPromptVersion(id)),
    },
  };
}

function handler(repository: GenerationCandidateRepository = candidates) {
  const audit = new RecordingAudit();
  return { audit, record: new RecordPrecheckVerdictHandler({ candidates: repository, clock: fixedClock, audit }) };
}

describe('RecordPrecheckVerdict', () => {
  it('records a verdict that reads back, with its detail, in the order recorded', async () => {
    const candidate = await stored();
    const { record } = handler();

    expectValue(await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'pass' }, contextFor(pipeline)));
    expectValue(
      await record.handle(
        { candidateId: candidate.candidateId, check: 'answer_verification', outcome: 'fail', detail: 'two solves disagree' },
        contextFor(pipeline),
      ),
    );

    const found = expectValue(await candidates.findById(candidate.candidateId));
    expect(found.state).toBe('proposed');
    expect(found.verdicts).toHaveLength(2);
    expect(found.verdicts[0]?.check).toBe('renderability');
    expect(found.verdicts[0]?.outcome).toBe('pass');
    expect(Object.hasOwn(found.verdicts[0]!, 'detail')).toBe(false);
    expect(found.verdicts[1]?.check).toBe('answer_verification');
    expect(found.verdicts[1]?.outcome).toBe('fail');
    expect(found.verdicts[1]?.detail).toBe('two solves disagree');
  });

  it('audits the act under the caller’s principal, naming the candidate and not the verdict’s working', async () => {
    const candidate = await stored();
    const { record, audit } = handler();
    expectValue(
      await record.handle(
        { candidateId: candidate.candidateId, check: 'syllabus_scope', outcome: 'pass', detail: 'secret working' },
        contextFor(pipeline, 'corr-v-1'),
      ),
    );
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.action).toBe('RecordPrecheckVerdict');
    expect(entry.targetType).toBe('GenerationCandidate');
    expect(entry.targetId).toBe(candidate.candidateId);
    expect(entry.principal).toBe(pipeline);
    expect(entry.correlationId).toBe('corr-v-1');
    expect(entry.occurredAt).toEqual(FIXED_NOW);
    expect(JSON.stringify(entry)).not.toContain('secret working');
  });

  it('is refused for a principal who is not the machine — Content Ops cannot write the audit trail', async () => {
    const candidate = await stored();
    const { record, audit } = handler();
    for (const roles of [['content_ops'], ['reviewer'], []]) {
      const failure = expectError(
        await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'pass' }, contextFor(principalWith(roles))),
      );
      expect(failure.code).toBe('NOT_PERMITTED');
    }
    expect(audit.entries).toEqual([]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toEqual([]);
  });

  describe('a check the vocabulary does not know is refused at the boundary, not at the database', () => {
    it('without reading or writing the store, and naming the field', async () => {
      const candidate = await stored();
      const { repository, calls } = observed();
      const { record, audit } = handler(repository);

      for (const check of ['grounding', '', '  ', 'Renderability', 'renderability ']) {
        const failure = expectError(await record.handle({ candidateId: candidate.candidateId, check, outcome: 'pass' }, contextFor(pipeline)));
        expect(failure.kind, check).toBe('Validation');
        expect(failure.code, check).toBe('VERDICT_CHECK_UNKNOWN');
        expect(failure.location, check).toBe('check');
      }
      expect(calls).toEqual([]);
      expect(audit.entries).toEqual([]);
      expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toEqual([]);
    });

    it('while every check the vocabulary does know is accepted', async () => {
      const candidate = await stored();
      const { record } = handler();
      for (const check of PRECHECK_IDS) {
        expectValue(await record.handle({ candidateId: candidate.candidateId, check, outcome: 'pass' }, contextFor(pipeline)));
      }
      expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toHaveLength(12);
    });
  });

  it('refuses an outcome that is neither pass nor fail, writing nothing', async () => {
    const candidate = await stored();
    const { record, audit } = handler();
    const failure = expectError(await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'maybe' }, contextFor(pipeline)));
    expect(failure.code).toBe('VERDICT_OUTCOME_UNKNOWN');
    expect(failure.location).toBe('verdict.outcome');
    expect(audit.entries).toEqual([]);
  });

  it('records the same check twice as a Conflict, leaving the first verdict standing', async () => {
    const candidate = await stored();
    const { record, audit } = handler();
    expectValue(await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'fail' }, contextFor(pipeline)));

    const failure = expectError(await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'pass' }, contextFor(pipeline)));
    expect(failure.kind).toBe('Conflict');
    expect(failure.code).toBe('VERDICT_ALREADY_RECORDED');
    expect(audit.entries).toHaveLength(1);
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts[0]?.outcome).toBe('fail');
  });

  it('reports two simultaneous recordings of one check as one success and one Conflict', async () => {
    const candidate = await stored();
    const { record } = handler();
    const results = await Promise.all(
      ['pass', 'fail'].map((outcome) => record.handle({ candidateId: candidate.candidateId, check: 'syllabus_scope', outcome }, contextFor(pipeline))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(expectError(results.find((result) => !result.ok)!).kind).toBe('Conflict');
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toHaveLength(1);
  });

  it('refuses a candidate that has been decided, naming its state, whichever way it was decided', async () => {
    const run = aRun();
    expectValue(await runs.save(run));
    const checked = BLOCKING_PRECHECKS.reduce(
      (current, check) => expectValue(recordVerdict(current, { check, outcome: 'pass' })),
      aCandidate(run),
    );
    const accepted = expectValue(acceptCandidate(checked));
    const rejected = expectValue(rejectCandidate(aCandidate(run)));
    for (const [decided, state] of [
      [accepted, 'accepted'],
      [rejected, 'rejected'],
    ] as const) {
      expectValue(await candidates.save(decided));
      const { record } = handler();
      const failure = expectError(
        await record.handle({ candidateId: decided.candidateId, check: 'duplicate_detection', outcome: 'pass' }, contextFor(pipeline)),
      );
      expect(failure.kind).toBe('RuleViolation');
      expect(failure.code).toBe('VERDICT_CANDIDATE_NOT_PROPOSED');
      expect(failure.message).toContain(state);
    }
  });

  it('reports a candidate that does not exist as NotFound', async () => {
    const { record } = handler();
    const failure = expectError(await record.handle({ candidateId: randomUUID(), check: 'renderability', outcome: 'pass' }, contextFor(pipeline)));
    expect(failure.kind).toBe('NotFound');
  });

  it('surfaces a store refusal as it is, without having recorded anything', async () => {
    const { record, audit } = handler();
    const failure = expectError(await record.handle({ candidateId: 'not-a-uuid', check: 'renderability', outcome: 'pass' }, contextFor(pipeline)));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(audit.entries).toEqual([]);
  });

  it('surfaces a failed save without auditing it', async () => {
    const candidate = await stored();
    const { repository } = observed();
    const failing: GenerationCandidateRepository = {
      ...repository,
      // A real save that the real repository refuses: the stored confidence differs.
      save: () => candidates.save({ ...candidate, confidence: 0.1 }),
    };
    const { record, audit } = handler(failing);
    const failure = expectError(await record.handle({ candidateId: candidate.candidateId, check: 'renderability', outcome: 'pass' }, contextFor(pipeline)));
    expect(failure.kind).toBe('Conflict');
    expect(audit.entries).toEqual([]);
  });
});
