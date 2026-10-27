import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { InMemoryAttempts, StubCorpus, StubPins } from '../../../testing/assessment-fakes.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import type { AssemblyCandidate } from '../domain/assembly.js';
import { err, ok, type Result } from '../domain/result.js';
import { LearningRemediationSource } from '../infrastructure/learning-remediation-source.js';
import { applicationError, type ApplicationError } from './authorization.js';
import { CreatePracticeAttemptHandler, GrowPracticeAttemptHandler, type PracticeDependencies } from './handlers/practice-handlers.js';
import type { AuditRecord, ApplicationContext, RemediationSource } from './ports.js';

const NOW = new Date('2026-10-27T09:00:00.000Z');
const learner = (n = 1): ApplicationContext => ({ principal: { kind: 'human', id: id(TAG.student, n), roleContext: ['learner'] }, correlationId: 'corr' });
const cand = (n: number, o: Partial<AssemblyCandidate> = {}): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null, ...o,
});

class RecordingRemediation implements RemediationSource {
  readonly asked: { taxonomyVersionId: string; limit: number; learner: string }[] = [];
  constructor(private readonly outcome: readonly string[] | ApplicationError) {}
  async conceptsFor(taxonomyVersionId: string, limit: number, context: ApplicationContext): Promise<Result<readonly string[], ApplicationError>> {
    this.asked.push({ taxonomyVersionId, limit, learner: context.principal.id });
    return Array.isArray(this.outcome) ? ok(this.outcome) : err(this.outcome as ApplicationError);
  }
}

function rig(options: { candidates?: AssemblyCandidate[]; remediation?: RemediationSource | undefined } = {}) {
  const attempts = new InMemoryAttempts();
  const corpus = new StubCorpus({ candidates: options.candidates ?? [cand(1), cand(2), cand(3), cand(4), cand(5)], exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] });
  const recorded: AuditRecord[] = [];
  let n = 0;
  const deps: PracticeDependencies = {
    attempts, corpus, practicePins: new StubPins(), intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    clock: { now: () => NOW }, identifiers: { next: () => id(0xd0, (n += 1)) }, audit: { record: async (e: AuditRecord) => void recorded.push(e) },
    ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
  };
  return { deps, attempts, corpus, recorded };
}
const create = (over: Record<string, unknown> = {}) => ({
  examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 3, idempotencyKey: 'k1', ...over,
});

describe('targeted practice crosses one seam, carrying concepts and never items', () => {
  it('asks Learning for the learner\'s concepts in the profile\'s taxonomy, and turns them into slots against the catalogue', async () => {
    const remediation = new RecordingRemediation([id(0xc0, 4), id(0xc0, 2)]);
    const { deps, attempts } = rig({ remediation });
    const created = expectValue(await new CreatePracticeAttemptHandler(deps).handle(create({ selectionStrategy: 'targeted', scopeFilter: undefined }) as never, learner()));
    expect(remediation.asked).toEqual([{ taxonomyVersionId: expectValue(await new StubPins().pinsFor('x')).taxonomyVersionId, limit: 5, learner: id(TAG.student, 1) }]);
    const stored = attempts.stored.get(created.attempt.attemptId)!;
    expect(stored.slots.map((slot) => slot.itemVersionId)).toEqual([id(TAG.itemVersion, 2), id(TAG.itemVersion, 4)]);
    expect(stored.mode).toBe('practice');
    expect([stored.formId, stored.windowClosesAt, stored.durationMs, stored.isTimed]).toEqual([null, null, null, false]);
  });

  it('says what it cannot do: nothing to remediate, no Learning composed in, and a failing Learning', async () => {
    const none = rig({ remediation: new RecordingRemediation([]) });
    expect(expectError(await new CreatePracticeAttemptHandler(none.deps).handle(create({ selectionStrategy: 'targeted' }) as never, learner())).code).toBe('NOTHING_TO_REMEDIATE');
    const absent = rig();
    expect(expectError(await new CreatePracticeAttemptHandler(absent.deps).handle(create({ selectionStrategy: 'targeted' }) as never, learner())).code).toBe('TARGETED_NOT_AVAILABLE');
    const failing = rig({ remediation: new RecordingRemediation(applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', 'down')) });
    expect(expectError(await new CreatePracticeAttemptHandler(failing.deps).handle(create({ selectionStrategy: 'targeted' }) as never, learner())).code).toBe('LEARNING_STORE_UNAVAILABLE');
  });

  it('the adapter forwards the question and the answer unchanged, and nothing else', async () => {
    const seen: unknown[] = [];
    const source = new LearningRemediationSource({ handle: async (query) => { seen.push(query); return ok({ conceptIdentityIds: [id(0xc0, 1)] }); } });
    expect(expectValue(await source.conceptsFor(id(TAG.taxonomy), 5, learner()))).toEqual([id(0xc0, 1)]);
    expect(seen).toEqual([{ taxonomyVersionId: id(TAG.taxonomy), limit: 5 }]);
  });
});

describe('a practice run is created and grown under its pinned policy', () => {
  it('reads the catalogue as the system and never gives the learner that reach', async () => {
    const { deps, corpus } = rig();
    expectValue(await new CreatePracticeAttemptHandler(deps).handle(create() as never, learner()));
    expect(corpus.requests).toEqual([{ subject: 'physics' }]);
  });

  it('is idempotent on the key, and a key reused for another profile is a conflict', async () => {
    const { deps, attempts } = rig();
    const handler = new CreatePracticeAttemptHandler(deps);
    const first = expectValue(await handler.handle(create() as never, learner()));
    const again = expectValue(await handler.handle(create() as never, learner()));
    expect([first.replayed, again.replayed, again.attempt.attemptId]).toEqual([false, true, first.attempt.attemptId]);
    expect(attempts.stored.size).toBe(1);
    expect(expectError(await handler.handle(create({ examProfileVersionId: id(TAG.profile, 2) }) as never, learner())).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a bad count, a bad type, an adaptive run, an unfiltered filtered run, spaced review, and a filter that matches nothing', async () => {
    const handler = new CreatePracticeAttemptHandler(rig().deps);
    const code = async (over: Record<string, unknown>) => expectError(await handler.handle(create(over) as never, learner())).code;
    expect(await code({ count: 0 })).toBe('PRACTICE_COUNT_INVALID');
    expect(await code({ count: 51 })).toBe('PRACTICE_COUNT_INVALID');
    expect(await code({ scopeFilter: { itemTypes: ['TELEPATHY'] } })).toBe('PRACTICE_SCOPE_INVALID');
    expect(await code({ selectionStrategy: 'adaptive' })).toBe('PRACTICE_ADAPTIVE_NOT_AVAILABLE');
    expect(await code({ scopeFilter: {} })).toBe('PRACTICE_FILTER_EMPTY');
    expect(await code({ selectionStrategy: 'spaced_review' })).toBe('SPACED_REVIEW_NOT_AVAILABLE');
    expect(await code({ difficultyBand: 'advanced', idempotencyKey: 'k2' })).toBe('NO_ITEMS_MATCH');
  });

  it('is a learner\'s alone', async () => {
    const operator: ApplicationContext = { principal: { kind: 'human', id: id(TAG.student, 1), roleContext: ['content_ops'] }, correlationId: 'c' };
    expect(expectError(await new CreatePracticeAttemptHandler(rig().deps).handle(create() as never, operator)).kind).toBe('Authorization');
  });

  it('grows a run by more items under the same policy, adding slots and changing none', async () => {
    const { deps, attempts } = rig();
    const created = expectValue(await new CreatePracticeAttemptHandler(deps).handle(create({ count: 2 }) as never, learner()));
    const before = attempts.stored.get(created.attempt.attemptId)!.slots;
    const grown = expectValue(await new GrowPracticeAttemptHandler(deps).handle({ attemptId: created.attempt.attemptId, count: 2 }, learner()));
    const after = attempts.stored.get(created.attempt.attemptId)!.slots;
    expect(grown.slotCount).toBe(4);
    expect(after.slice(0, 2)).toEqual(before);
    expect(new Set(after.map((slot) => slot.itemId)).size).toBe(4);
    expect(after.map((slot) => slot.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('stops growing when the catalogue has nothing further, and refuses someone else\'s run and a mock', async () => {
    const { deps, attempts } = rig({ candidates: [cand(1), cand(2)] });
    const created = expectValue(await new CreatePracticeAttemptHandler(deps).handle(create({ count: 5 }) as never, learner()));
    expect(created.attempt.slotCount).toBe(2);
    const grow = new GrowPracticeAttemptHandler(deps);
    expect(expectError(await grow.handle({ attemptId: created.attempt.attemptId, count: 1 }, learner())).code).toBe('NO_FURTHER_ITEMS');
    expect(expectError(await grow.handle({ attemptId: created.attempt.attemptId, count: 1 }, learner(2))).kind).toBe('NotFound');
    const mock = (await import('../../../testing/assessment-fixtures.js')).anAttempt({ studentId: id(TAG.student, 1), attemptId: id(TAG.attempt, 9) });
    attempts.stored.set(mock.attemptId, mock);
    expect(expectError(await grow.handle({ attemptId: mock.attemptId, count: 1 }, learner())).code).toBe('ATTEMPT_NOT_PRACTICE');
  });
});
