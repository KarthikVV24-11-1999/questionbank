import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { InMemoryAttempts, InMemoryForms, StubCorpus, StubPins, StubScoreRecords } from '../../../testing/assessment-fakes.js';
import { SESSION_REF, TAG, WITHIN_WINDOW, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { expectValue } from '../../../testing/expect-result.js';
import type { AssemblyCandidate } from '../domain/assembly.js';
import { err, ok, type Result } from '../domain/result.js';
import { LearningScopeSource } from '../infrastructure/learning-scope-source.js';
import { applicationError, type ApplicationError } from './authorization.js';
import { CreateAttemptHandler } from './handlers/attempt-handlers.js';
import { CreatePracticeAttemptHandler, GrowPracticeAttemptHandler, type PracticeDependencies } from './handlers/practice-handlers.js';
import type { ApplicationContext, AuditRecord, LearnerScopeSource, RemediationSource } from './ports.js';

/**
 * The learner's declared scope narrows practice and never a mock (M8-21, FR-STU-02 rule 1, ADR-0060). A mock that a scope had narrowed would still deliver and still score and would no longer
 * be the real paper, so the second half of this file is the one that matters: the scope source is composed into the whole set of handlers, offered to every one of them, and a mock is
 * created from a form with a scope in force that would have excluded most of it.
 */
const NOW = new Date('2026-11-04T09:00:00.000Z');
const learner = (): ApplicationContext => ({ principal: { kind: 'human', id: id(TAG.student, 1), roleContext: ['learner'] }, correlationId: 'corr' });
const cand = (n: number, o: Partial<AssemblyCandidate> = {}): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null, ...o,
});
const concept = (n: number): string => id(0xc0, n);

class ScopeScript implements LearnerScopeSource {
  readonly asked: Array<{ taxonomyVersionId: string; learner: string }> = [];
  constructor(private readonly outcome: readonly string[] | null | ApplicationError) {}
  async conceptsInScope(taxonomyVersionId: string, context: ApplicationContext): Promise<Result<readonly string[] | null, ApplicationError>> {
    this.asked.push({ taxonomyVersionId, learner: context.principal.id });
    return this.outcome === null || Array.isArray(this.outcome) ? ok(this.outcome as readonly string[] | null) : err(this.outcome as ApplicationError);
  }
}

function rig(options: { learnerScope?: LearnerScopeSource; remediation?: RemediationSource; candidates?: AssemblyCandidate[] } = {}) {
  const attempts = new InMemoryAttempts();
  const corpus = new StubCorpus({ candidates: options.candidates ?? [cand(1), cand(2), cand(3), cand(4), cand(5), cand(6)], exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] });
  let n = 0;
  const deps: PracticeDependencies = {
    attempts, corpus, practicePins: new StubPins(), intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    clock: { now: () => NOW }, identifiers: { next: () => id(0xd0, (n += 1)) }, audit: { record: async (_entry: AuditRecord) => undefined },
    ...(options.learnerScope === undefined ? {} : { learnerScope: options.learnerScope }),
    ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
  };
  return { deps, attempts };
}
const request = (over: Record<string, unknown> = {}) => ({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 6, idempotencyKey: 'k1', ...over });
const itemsOf = (r: ReturnType<typeof rig>, attemptId: string): string[] => r.attempts.stored.get(attemptId)!.slots.map((slot) => slot.itemVersionId).sort();
const versions = (...ns: number[]): string[] => ns.map((n) => id(TAG.itemVersion, n)).sort();

describe('practice is drawn from what the learner has studied', () => {
  it('only from items about a concept in scope, for the taxonomy version the attempt is pinned to, as the learner', async () => {
    const scope = new ScopeScript([concept(2), concept(5)]);
    const r = rig({ learnerScope: scope });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toEqual(versions(2, 5));
    expect(scope.asked).toEqual([{ taxonomyVersionId: expectValue(await new StubPins().pinsFor('x')).taxonomyVersionId, learner: id(TAG.student, 1) }]);
  });

  it('counts an item about several concepts as in scope when any one is', async () => {
    const r = rig({ learnerScope: new ScopeScript([concept(3)]), candidates: [cand(1, { conceptIdentityIds: [concept(1), concept(3)] }), cand(2)] });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toEqual(versions(1));
  });

  it('is nothing narrowed when no scope is in force: the answer is null, as for a learner who never declared one or skipped', async () => {
    const r = rig({ learnerScope: new ScopeScript(null) });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toEqual(versions(1, 2, 3, 4, 5, 6));
  });

  it('is nothing narrowed when Learning is not composed in', async () => {
    const r = rig();
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toHaveLength(6);
  });

  it('still practises when the scope cannot be read: a profile that is unavailable is never the reason a learner cannot practise', async () => {
    const r = rig({ learnerScope: new ScopeScript(applicationError('Unavailable', 'PROFILE_UNAVAILABLE', 'down')) });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toHaveLength(6);
  });

  it('says plainly that no item matches when the scope leaves none, instead of falling back to everything', async () => {
    const r = rig({ learnerScope: new ScopeScript([concept(99)]) });
    const refused = await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner());
    expect(refused).toMatchObject({ ok: false, error: { code: 'NO_ITEMS_MATCH' } });
  });

  it('narrows a targeted run too: the concepts Learning named, among those in scope', async () => {
    const remediation: RemediationSource = { conceptsFor: async () => ok([concept(2), concept(4), concept(6)]) };
    const r = rig({ learnerScope: new ScopeScript([concept(4), concept(5), concept(6)]), remediation });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request({ selectionStrategy: 'targeted', scopeFilter: undefined }) as never, learner()));
    expect(itemsOf(r, created.attempt.attemptId)).toEqual(versions(4, 6));
  });

  it('narrows a run that is grown as it narrowed the run it grows', async () => {
    const r = rig({ learnerScope: new ScopeScript([concept(1), concept(2), concept(3)]) });
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request({ count: 1 }) as never, learner()));
    const grown = expectValue(await new GrowPracticeAttemptHandler(r.deps).handle({ attemptId: created.attempt.attemptId, count: 5 } as never, learner()));
    expect(grown).toBeDefined();
    expect(itemsOf(r, created.attempt.attemptId).every((version) => versions(1, 2, 3).includes(version))).toBe(true);
    expect(itemsOf(r, created.attempt.attemptId)).toHaveLength(3);
  });
});

describe('a mock exam is the real paper, whatever the learner has declared (FR-STU-02 rule 1)', () => {
  const FORM = anActiveForm();

  it('is delivered whole while a scope that would leave out most of it is in force and offered to every handler', async () => {
    const scope = new ScopeScript([concept(1)]);
    const forms = new InMemoryForms();
    forms.stored.set(FORM.formId, FORM);
    const attempts = new InMemoryAttempts();
    let n = 0;
    // the scope source sits in the same dependencies as the mock handler's own, as it does in the composition
    const deps = {
      forms, attempts, pins: new StubPins(), intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS, scoreRecord: new StubScoreRecords(), learnerScope: scope,
      clock: { now: () => new Date(WITHIN_WINDOW) }, identifiers: { next: () => id(TAG.attempt, (n += 1)) }, audit: { record: async (_entry: AuditRecord) => undefined },
    };
    const created = expectValue(await new CreateAttemptHandler(deps as never).handle({ formId: FORM.formId, sessionRef: SESSION_REF, idempotencyKey: 'k' }, learner()));
    const stored = attempts.stored.get(created.attempt.attemptId)!;
    const formSlots = FORM.sections.flatMap((section) => section.slots);
    expect(stored.slots.map((slot) => slot.itemVersionId)).toEqual(formSlots.map((slot) => slot.itemVersionId));
    expect(stored.slots.length).toBeGreaterThan(1);
    expect(scope.asked).toEqual([]);
  });

  it('is asked of Learning by practice alone: one question per practice run, none for a mock', async () => {
    const scope = new ScopeScript([concept(1)]);
    const r = rig({ learnerScope: scope });
    expectValue(await new CreatePracticeAttemptHandler(r.deps).handle(request() as never, learner()));
    expect(scope.asked).toHaveLength(1);
  });
});

describe('the adapter between Assessment and Learning', () => {
  it('forwards the question and the answer unchanged, and none of Learning\'s other words', async () => {
    const seen: unknown[] = [];
    const source = new LearningScopeSource({ handle: async (query) => (seen.push(query), ok({ conceptIdentityIds: [concept(1)] })) });
    expect(expectValue(await source.conceptsInScope(id(TAG.taxonomy), learner()))).toEqual([concept(1)]);
    expect(seen).toEqual([{ taxonomyVersionId: id(TAG.taxonomy) }]);
  });

  it('passes on no scope as no scope, and a refusal as one', async () => {
    expect(expectValue(await new LearningScopeSource({ handle: async () => ok({ conceptIdentityIds: null }) }).conceptsInScope('t', learner()))).toBeNull();
    const refused = await new LearningScopeSource({ handle: async () => err(applicationError('Unavailable', 'PROFILE_UNAVAILABLE', 'x')) }).conceptsInScope('t', learner());
    expect(refused).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'PROFILE_UNAVAILABLE' } });
  });
});
