import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, registering } from '../../../../testing/generation-fixtures.js';
import { RecordingAudit, contextFor, fixedClock, principalWith } from '../../../../testing/generation-context.js';
import { PostgresGenerationCandidateRepository } from '../../infrastructure/generation-candidate.repository.js';
import { acceptCandidate, rejectCandidate, type GenerationCandidate } from '../../domain/generation-candidate.js';
import { BLOCKING_PRECHECKS, PRECHECKS, PRECHECK_IDS, type PrecheckId } from '../../domain/precheck-vocabulary.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { BlockedPrecheck, CheckOutcome, PrecheckRunner } from '../prechecks/battery.js';
import { RunPrecheckBatteryHandler } from './battery-handlers.js';
import { RecordPrecheckVerdictHandler } from './verdict-handlers.js';

/**
 * The battery's own behaviour — recording, accounting, idempotence — against
 * real Postgres. The checks here are scripted: they stand in for check *logic*,
 * which has its own specs; what is under test is everything around it.
 */
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

async function stored(): Promise<GenerationCandidate> {
  const run = aRun();
  expectValue(await runs.save(run));
  const candidate = aCandidate(run);
  expectValue(await candidates.save(candidate));
  return candidate;
}

const passing = (check: PrecheckId, detail?: string): PrecheckRunner => ({
  check,
  run: async () => ok<CheckOutcome>({ outcome: 'pass', ...(detail === undefined ? {} : { detail }) }),
});
const failing = (check: PrecheckId, detail = 'it did not hold'): PrecheckRunner => ({
  check,
  run: async () => ok<CheckOutcome>({ outcome: 'fail', detail }),
});

function battery(runners: readonly PrecheckRunner[], blocked: readonly BlockedPrecheck[] = []) {
  const audit = new RecordingAudit();
  const recordVerdict = new RecordPrecheckVerdictHandler({ candidates, clock: fixedClock, audit });
  return { audit, handler: new RunPrecheckBatteryHandler({ candidates, recordVerdict, runners, blocked, clock: fixedClock, audit }) };
}

/** Every check implemented or blocked: a configuration with nothing left unaccounted. */
const everythingBut = (omitted: readonly PrecheckId[]): PrecheckRunner[] =>
  PRECHECK_IDS.filter((check) => !omitted.includes(check)).map((check) => passing(check));

describe('the report always has one line per check, in the vocabulary’s order', () => {
  it('twelve lines whatever ran, each with the severity the vocabulary gives it', async () => {
    const candidate = await stored();
    const report = expectValue(await battery([passing('renderability')]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(report.candidateId).toBe(candidate.candidateId);
    expect(report.checks.map((line) => line.check)).toEqual(PRECHECK_IDS);
    expect(report.checks.map((line) => line.severity)).toEqual(PRECHECKS.map((check) => check.severity));
  });
});

describe('a check that ran is recorded, once', () => {
  it('records a verdict for each check that ran, with its detail, and reports each as recorded', async () => {
    const candidate = await stored();
    const { handler } = battery([passing('renderability', 'all four surfaces'), failing('duplicate_detection', 'near neighbour')]);
    const report = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    const lines = Object.fromEntries(report.checks.map((line) => [line.check, line]));
    expect(lines['renderability']).toMatchObject({ status: 'recorded', outcome: 'pass', detail: 'all four surfaces' });
    expect(lines['duplicate_detection']).toMatchObject({ status: 'recorded', outcome: 'fail', detail: 'near neighbour' });

    const stored_ = expectValue(await candidates.findById(candidate.candidateId));
    expect(stored_.verdicts.map((verdict) => [verdict.check, verdict.outcome])).toEqual([
      ['renderability', 'pass'],
      ['duplicate_detection', 'fail'],
    ]);
    expect(stored_.verdicts[0]?.detail).toBe('all four surfaces');
  });

  it('records no more than one verdict per check however many times the battery runs', async () => {
    const candidate = await stored();
    const { handler } = battery([passing('renderability'), passing('syllabus_scope')]);
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    const second = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(second.checks.filter((line) => line.status === 'already_recorded').map((line) => line.check)).toEqual(['renderability', 'syllabus_scope']);
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toHaveLength(2);
  });

  it('does not run a check again once it has a verdict, and leaves an earlier fail standing over a later pass', async () => {
    const candidate = await stored();
    expectValue(await battery([failing('renderability', 'first answer')]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    let asked = 0;
    const counting: PrecheckRunner = { check: 'renderability', run: async () => (asked += 1, ok<CheckOutcome>({ outcome: 'pass' })) };
    expectValue(await battery([counting]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(asked).toBe(0);
    const verdicts = expectValue(await candidates.findById(candidate.candidateId)).verdicts;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ check: 'renderability', outcome: 'fail', detail: 'first answer' });
  });

  it('fills the gaps on a re-run: a check that could not run the first time runs the second', async () => {
    const candidate = await stored();
    const flaky: PrecheckRunner = { check: 'safety_appropriateness', run: async () => err(applicationError('Unavailable', 'PROVIDER_DOWN', 'down')) };
    const first = expectValue(await battery([passing('renderability'), flaky]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(first.checks.find((line) => line.check === 'safety_appropriateness')?.status).toBe('could_not_run');

    const second = expectValue(await battery([passing('renderability'), passing('safety_appropriateness')]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(second.checks.find((line) => line.check === 'safety_appropriateness')?.status).toBe('recorded');
    expect(second.checks.find((line) => line.check === 'renderability')?.status).toBe('already_recorded');
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts.map((verdict) => verdict.check)).toEqual([
      'renderability',
      'safety_appropriateness',
    ]);
  });
});

describe('a check that did not run is not a check that passed', () => {
  it('records nothing for a check that could not run, and reports the typed reason', async () => {
    const candidate = await stored();
    const down: PrecheckRunner = { check: 'answer_verification', run: async () => err(applicationError('Unavailable', 'PROVIDER_DOWN', 'try later')) };
    const report = expectValue(await battery([down]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(report.checks.find((line) => line.check === 'answer_verification')).toMatchObject({
      status: 'could_not_run',
      error: { code: 'PROVIDER_DOWN', message: 'try later' },
    });
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toEqual([]);
  });

  it('contains a check that raises, records nothing for it, and still runs the rest', async () => {
    const candidate = await stored();
    for (const thrown of [new Error('boom'), 'a bare string']) {
      const raising: PrecheckRunner = {
        check: 'renderability',
        run: async () => {
          throw thrown;
        },
      };
      const report = expectValue(await battery([raising, passing('syllabus_scope')]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
      expect(report.checks.find((line) => line.check === 'renderability')).toMatchObject({
        status: 'could_not_run',
        error: { code: 'CHECK_RAISED', message: thrown instanceof Error ? 'boom' : 'a bare string' },
      });
      expect(report.checks.find((line) => line.check === 'syllabus_scope')?.status === 'recorded' || report.checks.find((line) => line.check === 'syllabus_scope')?.status === 'already_recorded').toBe(true);
    }
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts.map((verdict) => verdict.check)).toEqual(['syllabus_scope']);
  });

  it('records nothing for a blocked check, and says why and what unblocks it', async () => {
    const candidate = await stored();
    const blocked: BlockedPrecheck = { check: 'schema_validity', reason: 'content exposes no validator over a proposal', successor: 'a pure validator in content' };
    const report = expectValue(await battery(everythingBut(['schema_validity']), [blocked]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(report.checks.find((line) => line.check === 'schema_validity')).toEqual({
      check: 'schema_validity',
      severity: 'blocking',
      status: 'blocked',
      blocked: { reason: 'content exposes no validator over a proposal', successor: 'a pure validator in content' },
    });
    const recorded = expectValue(await candidates.findById(candidate.candidateId)).verdicts.map((verdict) => verdict.check);
    expect(recorded).not.toContain('schema_validity');
    expect(recorded).toHaveLength(11);
  });

  it('reports a check that is neither implemented nor blocked as unaccounted, rather than leaving it out', async () => {
    const candidate = await stored();
    const report = expectValue(await battery([]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(report.checks.every((line) => line.status === 'unaccounted')).toBe(true);
    expect(report.checks).toHaveLength(12);
    expect(expectValue(await candidates.findById(candidate.candidateId)).verdicts).toEqual([]);
  });

  it('reports a result it could not record as such, and records nothing', async () => {
    const candidate = await stored();
    const refusing = new RunPrecheckBatteryHandler({
      candidates,
      recordVerdict: { name: 'x', policy: battery([]).handler.policy, handle: async () => err(applicationError('Conflict', 'VERDICT_ALREADY_RECORDED', 'someone got there first')) },
      runners: [passing('renderability')],
      blocked: [],
      clock: fixedClock,
      audit: new RecordingAudit(),
    });
    const report = expectValue(await refusing.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(report.checks.find((line) => line.check === 'renderability')).toMatchObject({
      status: 'could_not_record',
      error: { code: 'VERDICT_ALREADY_RECORDED' },
    });
  });
});

describe('a candidate with a check that did not run cannot be accepted', () => {
  it('whatever else passed: acceptance still refuses, naming the gap', async () => {
    const candidate = await stored();
    const omitted: PrecheckId = 'item_solution_key_consistency';
    expectValue(await battery(everythingBut([omitted]), [{ check: omitted, reason: 'r', successor: 's' }]).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    const failure = expectError(acceptCandidate(expectValue(await candidates.findById(candidate.candidateId))));
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    expect(failure.message).toContain(omitted);
  });

  it('while a candidate every blocking check ran for and passed can be', async () => {
    const candidate = await stored();
    expectValue(await battery(everythingBut([])).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(expectValue(acceptCandidate(expectValue(await candidates.findById(candidate.candidateId)))).state).toBe('accepted');
  });
});

describe('a failing blocking check means it can never be accepted; a failing advisory check does not', () => {
  it('for every blocking check', async () => {
    for (const blocking of BLOCKING_PRECHECKS) {
      const candidate = await stored();
      const runners = PRECHECK_IDS.map((check) => (check === blocking ? failing(check, `${check} failed`) : passing(check)));
      expectValue(await battery(runners).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

      const failure = expectError(acceptCandidate(expectValue(await candidates.findById(candidate.candidateId))));
      expect(failure.code, blocking).toBe('CANDIDATE_PRECHECK_FAILED');
      expect(failure.message).toContain(blocking);
    }
  });

  it('but not for the three advisory ones', async () => {
    const candidate = await stored();
    const advisory: readonly PrecheckId[] = PRECHECKS.filter((check) => check.severity === 'advisory').map((check) => check.id);
    const runners = PRECHECK_IDS.map((check) => (advisory.includes(check) ? failing(check) : passing(check)));
    expectValue(await battery(runners).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(expectValue(acceptCandidate(expectValue(await candidates.findById(candidate.candidateId)))).state).toBe('accepted');
  });
});

describe('who may run it, and on what', () => {
  it('only the pipeline: Content Ops and a stranger are refused, and nothing runs', async () => {
    const candidate = await stored();
    let asked = 0;
    const counting: PrecheckRunner = { check: 'renderability', run: async () => (asked += 1, ok<CheckOutcome>({ outcome: 'pass' })) };
    const { handler, audit } = battery([counting]);
    for (const roles of [['content_ops'], ['author'], []]) {
      expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(principalWith(roles)))).code).toBe('NOT_PERMITTED');
    }
    expect(asked).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('reports a candidate that does not exist as NotFound', async () => {
    expect(expectError(await battery([]).handler.handle({ candidateId: randomUUID() }, contextFor(machine))).kind).toBe('NotFound');
  });

  it('refuses a candidate that has been decided, naming its state, and runs nothing', async () => {
    const run = aRun();
    expectValue(await runs.save(run));
    const rejected = expectValue(rejectCandidate(aCandidate(run)));
    expectValue(await candidates.save(rejected));
    let asked = 0;
    const counting: PrecheckRunner = { check: 'renderability', run: async () => (asked += 1, ok<CheckOutcome>({ outcome: 'pass' })) };
    const failure = expectError(await battery([counting]).handler.handle({ candidateId: rejected.candidateId }, contextFor(machine)));
    expect(failure.kind).toBe('RuleViolation');
    expect(failure.message).toContain('rejected');
    expect(asked).toBe(0);
  });

  it('audits the run under the caller’s principal and correlation id', async () => {
    const candidate = await stored();
    const { handler, audit } = battery([passing('renderability')]);
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine, 'corr-battery-1')));
    const entry = audit.entries.find((recorded) => recorded.action === 'RunPrecheckBattery');
    expect(entry?.principal).toBe(machine);
    expect(entry?.correlationId).toBe('corr-battery-1');
    expect(entry?.targetId).toBe(candidate.candidateId);
    expect(audit.entries.filter((recorded) => recorded.action === 'RecordPrecheckVerdict')).toHaveLength(1);
  });

  it('surfaces a store refusal as it is', async () => {
    expect(expectError(await battery([]).handler.handle({ candidateId: 'not-a-uuid' }, contextFor(machine))).code).toBe('PERSISTENCE_REJECTED');
  });
});
