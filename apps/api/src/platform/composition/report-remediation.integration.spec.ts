import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplicationContext as AssessmentContext } from '../../contexts/assessment/application/ports.js';
import { CreatePracticeAttemptHandler } from '../../contexts/assessment/application/handlers/practice-handlers.js';
import type { AssemblyCandidate } from '../../contexts/assessment/domain/assembly.js';
import { LearningRemediationSource } from '../../contexts/assessment/infrastructure/learning-remediation-source.js';
import { learningForAssessment, learningForLearner, learningForRelay, type MasteryEvidence } from '../../contexts/learning/public/composition.js';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../config/config.js';
import { InMemoryAttempts, StubCorpus, StubPins } from '../../testing/assessment-fakes.js';
import { TAG, id } from '../../testing/assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';

/**
 * A finding leads to its remediation (M7-43), proved at the handler level and no further. The roadmap's "one tap" needs a practice route, and there is none to tap (D78,
 * Track H): this holds the chain a tap would run — the report names a concept and says a targeted run would be about it, and that run, started through the seam
 * Learning offers Assessment, is made of items for that concept and no other.
 */
let database: TestDatabase;
const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: ['system'] }, correlationId: 'c' };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const candidate = (n: number, concept: string): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [concept], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null,
});

describe('from a finding to the practice run that would address it', () => {
  it('names the concept the mock cost the most marks on, says a targeted run would be about it, and the run started through the seam is made of its items', async () => {
    const pins = expectValue(await new StubPins().pinsFor('x'));
    const taxonomy = pins.taxonomyVersionId;
    const learner = id(TAG.student, 7);
    const [lost, other] = [randomUUID(), randomUUID()];
    const now = new Date('2026-10-28T10:00:00.000Z');
    const deps = { pool: database.pool, clock: { now: () => now }, identifiers: { next: () => randomUUID() } };

    // the learner got four wrong on `lost` in the mock: that is the evidence the report and the practice run both stand on
    const evidence: MasteryEvidence[] = [0, 1, 2, 3].map((i) => ({ attemptRef: randomUUID(), slotRef: `s${i}`, itemVersionRef: randomUUID(), conceptIdentityId: lost, taxonomyVersionId: taxonomy, outcome: 'incorrect', difficultyEstimate: 'moderate', occurredAt: new Date(Date.UTC(2026, 9, 28, 9, i)).toISOString(), scoredAt: now.toISOString() }));
    const relay = learningForRelay(deps);
    expectValue(await relay.recordEvidence.handle({ learnerRef: learner, evidence }, system));
    const attempt = randomUUID();
    const slot = (n: number, concept: string, awarded: string) => ({ slotRef: `m${n}`, conceptIdentityId: concept, taxonomyVersionId: taxonomy, outcome: 'incorrect', marksAwarded: awarded, marksAvailable: '4' });
    expectValue(await relay.generateReport.handle({ learnerRef: learner, attemptRef: attempt, scoreRecordRef: randomUUID(), slots: [slot(1, lost, '-1'), slot(2, lost, '-1'), slot(3, other, '3')] }, system));

    const report = expectValue(await learningForLearner({ ...deps, standings: { standings: async () => ({ ok: true as const, value: [] }) }, paceSlots: { paceSlotsForAttempt: async () => ({ ok: true as const, value: [] }) } }).getReport.handle({ attemptId: attempt }, { principal: { kind: 'human', id: learner, roleContext: ['learner'] }, correlationId: 'c' }));
    const [top] = report.findings;
    expect(top).toMatchObject({ rank: 1, conceptIdentityId: lost, marksLost: '10', remediation: { strategy: 'targeted', taxonomyVersionId: taxonomy, conceptIdentityId: lost, selected: true } });

    // the run: assessment asks Learning which concepts, as it always does, and builds the run from the catalogue
    const attempts = new InMemoryAttempts();
    const catalogue = [candidate(1, other), candidate(2, lost), candidate(3, other), candidate(4, lost)];
    let n = 0;
    const handler = new CreatePracticeAttemptHandler({
      attempts,
      corpus: new StubCorpus({ candidates: catalogue, exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }),
      practicePins: new StubPins(),
      remediation: new LearningRemediationSource(learningForAssessment({ pool: database.pool }).remediationConcepts),
      intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
      clock: { now: () => now },
      identifiers: { next: () => id(0xd0, (n += 1)) },
      audit: { record: async () => undefined },
    });
    const context: AssessmentContext = { principal: { kind: 'human', id: learner, roleContext: ['learner'] }, correlationId: 'c' };
    const created = expectValue(await handler.handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'targeted', count: 4, idempotencyKey: 'tap' } as never, context));

    const run = attempts.stored.get(created.attempt.attemptId)!;
    expect(run.mode).toBe('practice');
    expect(run.slots.map((s) => s.itemVersionId).sort()).toEqual([id(TAG.itemVersion, 2), id(TAG.itemVersion, 4)]);
    expect(top!.remediation.conceptIdentityId).toBe(lost);
  });
});
