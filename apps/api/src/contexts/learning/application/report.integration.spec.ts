import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import type { ReportSlot } from '../domain/diagnostic-report.js';
import type { MasteryEvidence } from '../domain/mastery-evidence.js';
import { PostgresConceptReader } from '../infrastructure/concept-reader.js';
import { PostgresDiagnosticReportStore } from '../infrastructure/diagnostic-report.repository.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';
import { RecordMasteryEvidenceHandler } from './handlers/record-evidence-handler.js';
import { GenerateDiagnosticReportHandler, GetDiagnosticReportHandler } from './handlers/report-handlers.js';

let database: TestDatabase;
const TAXONOMY = randomUUID();
const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: ['system'] }, correlationId: 'c' };
const learnerContext = (id: string) => ({ principal: { kind: 'human' as const, id, roleContext: ['learner'] }, correlationId: 'c' });
const NOW = '2026-10-28T10:00:00.000Z';

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  await database.pool.query('TRUNCATE learning.report_finding, learning.diagnostic_report, learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.study_session, learning.mastery_evidence');
});

const reports = () => new PostgresDiagnosticReportStore(database.pool);
const generator = () => new GenerateDiagnosticReportHandler({ reports: reports(), clock: { now: () => new Date(NOW) }, identifiers: { next: () => randomUUID() } });
const reader = () => new GetDiagnosticReportHandler({ reports: reports(), concepts: new PostgresConceptReader(database.pool) });
const slot = (n: number, concept: string, outcome: string, awarded: string, available: string): ReportSlot => ({ slotRef: `s${n}`, conceptIdentityId: concept, taxonomyVersionId: TAXONOMY, outcome, marksAwarded: awarded, marksAvailable: available });

describe('a report for a scored mock', () => {
  it('is stored with its findings ranked by marks lost, and read back by the learner it belongs to with the marks as text', async () => {
    const learner = randomUUID();
    const attempt = randomUUID();
    const [hard, easy] = [randomUUID(), randomUUID()];
    const made = expectValue(await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [slot(1, easy, 'incorrect', '-1', '4'), slot(2, hard, 'incorrect', '-1', '4'), slot(3, hard, 'unattempted', '0', '4')] }, system));
    expect(made.created).toBe(true);

    const view = expectValue(await reader().handle({ attemptId: attempt }, learnerContext(learner)));
    expect(view.findings.map((f) => [f.rank, f.conceptIdentityId, f.marksLost, f.marksAvailable, f.slots, f.skipped])).toEqual([[1, hard, '9', '8', 2, 1], [2, easy, '5', '4', 1, 0]]);
    expect(view.findings[0]!.remediation).toEqual({ strategy: 'targeted', taxonomyVersionId: TAXONOMY, conceptIdentityId: hard, selected: false });
  });

  it('is one report however often the same score is reported, and a new score is a new report beside it', async () => {
    const learner = randomUUID();
    const attempt = randomUUID();
    const concept = randomUUID();
    const first = randomUUID();
    const command = (record: string, awarded: string) => ({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: record, slots: [slot(1, concept, 'incorrect', awarded, '4')] });
    expectValue(await generator().handle(command(first, '0'), system));
    expect(expectValue(await generator().handle(command(first, '0'), system))).toMatchObject({ created: false, reportId: null });
    expect((await database.pool.query('SELECT count(*)::int AS n FROM learning.diagnostic_report')).rows[0].n).toBe(1);

    expect(expectValue(await reader().handle({ attemptId: attempt }, learnerContext(learner))).scoreRecordId).toBe(first);
    const second = randomUUID();
    expectValue(await generator().handle(command(second, '3'), system));
    expect((await database.pool.query('SELECT count(*)::int AS n FROM learning.diagnostic_report')).rows[0].n).toBe(2);
    // the learner reads the report for the score that stands, labelled with it so a screen can say the first was replaced; the one they were first shown is still on record
    const standing = expectValue(await reader().handle({ attemptId: attempt }, learnerContext(learner)));
    expect(standing.findings[0]!.marksLost).toBe('1');
    expect(standing.scoreRecordId).toBe(second);
  });

  it('says a concept the learner is weak on is one a targeted run would take, and a concept the learner has no standing on yet is not', async () => {
    const learner = randomUUID();
    const [weak, fine] = [randomUUID(), randomUUID()]; // `fine` has never been assessed: a targeted run is about what the learner has attempted and not mastered
    const response = (concept: string, i: number, outcome: 'correct' | 'incorrect'): MasteryEvidence => ({ attemptRef: randomUUID(), slotRef: `r${i}`, itemVersionRef: randomUUID(), conceptIdentityId: concept, taxonomyVersionId: TAXONOMY, outcome, difficultyEstimate: 'moderate', occurredAt: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(), scoredAt: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString() });
    const recorder = new RecordMasteryEvidenceHandler({ ledger: new PostgresLearningLedger(database.pool), ruleSets: new PostgresMasteryRuleSetRepository(database.pool), clock: { now: () => new Date(NOW) }, identifiers: { next: () => randomUUID() } });
    expectValue(await recorder.handle({ learnerRef: learner, evidence: [0, 1, 2, 3].map((i) => response(weak, i, 'incorrect')) }, system));
    const attempt = randomUUID();
    expectValue(await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [slot(1, weak, 'incorrect', '0', '4'), slot(2, fine, 'incorrect', '0', '2')] }, system));
    const view = expectValue(await reader().handle({ attemptId: attempt }, learnerContext(learner)));
    expect(view.findings.map((f) => [f.conceptIdentityId, f.remediation.selected])).toEqual([[weak, true], [fine, false]]);
  });

  it('is the learner\'s own: another learner, a non-learner and an attempt with no report each get nothing', async () => {
    const learner = randomUUID();
    const attempt = randomUUID();
    expectValue(await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [slot(1, randomUUID(), 'incorrect', '0', '4')] }, system));
    expect(expectError(await reader().handle({ attemptId: attempt }, learnerContext(randomUUID()))).code).toBe('REPORT_NOT_FOUND');
    expect(expectError(await reader().handle({ attemptId: randomUUID() }, learnerContext(learner))).code).toBe('REPORT_NOT_FOUND');
    expect(expectError(await reader().handle({ attemptId: attempt }, { ...learnerContext(learner), principal: { kind: 'system', id: learner, roleContext: ['system'] } })).code).toBe('NOT_PERMITTED');
    expect(expectError(await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [] }, learnerContext(learner))).code).toBe('NOT_PERMITTED');
  });

  it('is history at the database: a report and its findings are never edited or deleted', async () => {
    const learner = randomUUID();
    expectValue(await generator().handle({ learnerRef: learner, attemptRef: randomUUID(), scoreRecordRef: randomUUID(), slots: [slot(1, randomUUID(), 'incorrect', '0', '4')] }, system));
    for (const sql of ['UPDATE learning.diagnostic_report SET generated_at = now()', 'DELETE FROM learning.diagnostic_report', 'UPDATE learning.report_finding SET rank = 9', 'DELETE FROM learning.report_finding']) {
      await expect(database.pool.query(sql)).rejects.toThrow('learning_report_is_history');
    }
  });

  it('reports a store it cannot reach as unavailable, on write and on read', async () => {
    const broken = { connect: async () => { throw new Error('down'); }, query: async () => { throw new Error('down'); } } as never;
    const store = new PostgresDiagnosticReportStore(broken);
    const base = { reportId: randomUUID(), learnerRef: randomUUID(), attemptRef: randomUUID(), scoreRecordRef: randomUUID(), generatedAt: NOW, findings: [] };
    expect(expectError(await store.insert(base)).code).toBe('REPORT_STORE_UNAVAILABLE');
    expect(expectError(await store.latest(base.learnerRef, base.attemptRef)).code).toBe('REPORT_STORE_UNAVAILABLE');
    const failingRead = new GetDiagnosticReportHandler({ reports: reports(), concepts: { weakest: async () => ({ ok: false, error: { kind: 'Unavailable', code: 'LEARNING_STORE_UNAVAILABLE', message: 'x' } }) } });
    const learner = randomUUID();
    const attempt = randomUUID();
    expectValue(await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [slot(1, randomUUID(), 'incorrect', '0', '4')] }, system));
    expect(expectError(await failingRead.handle({ attemptId: attempt }, learnerContext(learner))).code).toBe('LEARNING_STORE_UNAVAILABLE');
  });

  it('rolls back a report whose findings cannot be written, so a report is never stored without them', async () => {
    const learner = randomUUID();
    const attempt = randomUUID();
    const bad = { ...slot(1, randomUUID(), 'incorrect', '0', '4') };
    // a finding the table refuses: a concept identifier that is not a uuid
    const result = await generator().handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [{ ...bad, conceptIdentityId: 'not-a-uuid' }] }, system);
    expect(expectError(result).code).toBe('REPORT_STORE_UNAVAILABLE');
    expect((await database.pool.query('SELECT count(*)::int AS n FROM learning.diagnostic_report WHERE attempt_ref = $1', [attempt])).rows[0].n).toBe(0);
  });
});
