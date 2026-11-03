import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../../platform/auth/roles.js';
import type { ExamChoice, LearnerProfile } from '../../domain/learner-profile.js';
import { err, ok } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, CurriculumSource, LearnerProfileStore } from '../ports.js';
import {
  GetLearnerProfileHandler,
  GetLearnerScopeHandler,
  GetScopeOptionsHandler,
  ListExamChoicesHandler,
  SkipOnboardingHandler,
  UpdateLearnerProfileHandler,
  GET_LEARNER_PROFILE_POLICY,
  GET_LEARNER_SCOPE_POLICY,
  GET_SCOPE_OPTIONS_POLICY,
  LIST_EXAM_CHOICES_POLICY,
  SKIP_ONBOARDING_POLICY,
  UPDATE_LEARNER_PROFILE_POLICY,
} from './profile-handlers.js';

const LEARNER = '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a';
const T1 = 'tax-1';
const T2 = 'tax-2';
const NOW = new Date('2026-11-04T09:00:00.000Z');
const asLearner = (id = LEARNER): ApplicationContext => ({ principal: { kind: 'human', id, roleContext: [ROLES.learner] }, correlationId: 'corr-1' });

/** A store in memory that refuses a save over a version it no longer holds, as the real one does. */
function memoryStore() {
  const rows = new Map<string, LearnerProfile>();
  const saves: Array<{ profile: LearnerProfile; expected: number | null }> = [];
  const store: LearnerProfileStore = {
    find: async (ref) => ok(rows.get(ref) ?? null),
    save: async (profile, expected) => {
      saves.push({ profile, expected });
      const held = rows.get(profile.learnerRef);
      if ((held?.version ?? null) !== expected) return err(applicationError('Conflict', 'PROFILE_CHANGED', 'changed'));
      rows.set(profile.learnerRef, profile);
      return ok(profile);
    },
  };
  return { store, rows, saves };
}

/** Curriculum as a script: the taxonomy version the exam resolves to is whatever the test sets, and every read is counted. */
function curriculum() {
  const state = { taxonomy: T1, resolveFails: null as ApplicationError | null, optionsFail: null as ApplicationError | null, calls: [] as string[] };
  const source: CurriculumSource = {
    examOptions: async () => (state.optionsFail ? err(state.optionsFail) : ok([{ examCode: 'JEE_MAIN', displayName: 'JEE Main', years: ['2027'] }])),
    resolveExam: async (examCode, targetYear) => {
      state.calls.push(`resolveExam ${examCode} ${targetYear}`);
      if (state.resolveFails) return err(state.resolveFails);
      if (examCode !== 'JEE_MAIN' || targetYear !== '2027') return err(applicationError('NotFound', 'NO_PROFILE_FOR_YEAR', `${examCode} has no exam profile active for ${targetYear}`));
      return ok({ examCode, targetYear, examProfileVersionId: `profile-for-${state.taxonomy}`, taxonomyVersionId: state.taxonomy } satisfies ExamChoice);
    },
    scopeOptions: async (taxonomyVersionId) => {
      state.calls.push(`scopeOptions ${taxonomyVersionId}`);
      return ok({ taxonomyVersionId, conceptTotal: 10, nodes: [{ nodeId: 'mech', parentNodeId: null, displayName: 'Mechanics', depth: 0 }] });
    },
    resolveScope: async (taxonomyVersionId, nodeIds) => {
      state.calls.push(`resolveScope ${taxonomyVersionId} ${nodeIds.join(',')}`);
      // a node belongs to one version: the chapters of the new version are not the old one's
      const known = taxonomyVersionId === T1 ? ['mech', 'optics'] : ['new-mech'];
      const unknown = nodeIds.filter((id) => !known.includes(id));
      if (unknown.length > 0) return err(applicationError('NotFound', 'SCOPE_NODES_UNKNOWN', `no node ${unknown.join(', ')}`));
      return ok({ conceptIdentityIds: nodeIds.flatMap((id) => [`${id}-c1`, `${id}-c2`]), conceptTotal: 10 });
    },
  };
  return { state, source };
}

function rig() {
  const { store, rows, saves } = memoryStore();
  const { state, source } = curriculum();
  const deps = { profiles: store, curriculum: source, clock: { now: () => NOW } };
  return { rows, saves, state, deps, get: new GetLearnerProfileHandler(deps), update: new UpdateLearnerProfileHandler(deps), skip: new SkipOnboardingHandler(deps), options: new GetScopeOptionsHandler(deps) };
}

const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('who may use the profile', () => {
  it('is the learner, for every handler, and nobody else', async () => {
    for (const declared of [GET_LEARNER_PROFILE_POLICY, UPDATE_LEARNER_PROFILE_POLICY, SKIP_ONBOARDING_POLICY, LIST_EXAM_CHOICES_POLICY, GET_SCOPE_OPTIONS_POLICY, GET_LEARNER_SCOPE_POLICY]) expect(declared.allowedRoles, declared.name).toEqual([ROLES.learner]);
    const { deps } = rig();
    const stranger: ApplicationContext = { principal: { kind: 'human', id: LEARNER, roleContext: [ROLES.author] }, correlationId: 'c' };
    for (const handler of [new GetLearnerProfileHandler(deps), new UpdateLearnerProfileHandler(deps), new SkipOnboardingHandler(deps), new ListExamChoicesHandler(deps), new GetScopeOptionsHandler(deps), new GetLearnerScopeHandler(deps)]) {
      expect(await (handler as { handle(q: never, c: ApplicationContext): Promise<unknown> }).handle({} as never, stranger), handler.name).toMatchObject({ ok: false, error: { code: 'NOT_PERMITTED' } });
    }
  });
});

describe('reading the profile', () => {
  it('is empty for a learner who has none, says the exam is the next thing, and creates nothing', async () => {
    const { get, rows } = rig();
    const view = value(await get.handle({}, asLearner()));
    expect(view).toMatchObject({ exam: null, currentClass: null, priorScore: null, scope: null, onboarding: { next: 'exam', skipped: false }, version: 1 });
    expect(rows.size).toBe(0);
  });

  it('reads only the caller\'s own profile', async () => {
    const { get, update } = rig();
    value(await update.handle({ currentClass: 'class_11' }, asLearner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')));
    expect(value(await get.handle({}, asLearner())).currentClass).toBeNull();
  });
});

describe('onboarding, a step at a time (FR-STU-01)', () => {
  it('takes the exam, resolves it through Curriculum, and keeps the versions it resolved to', async () => {
    const { update, rows, state } = rig();
    const view = value(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    expect(view.exam).toEqual({ examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'profile-for-tax-1', taxonomyVersionId: T1 });
    expect(view.onboarding.next).toBe('class');
    expect(rows.get(LEARNER)!.exam).toEqual(view.exam);
    expect(state.calls).toContain('resolveExam JEE_MAIN 2027');
  });

  it('says in the learner\'s words when the exam or the year is not one Curriculum has, and saves nothing', async () => {
    const { update, rows } = rig();
    expect(await update.handle({ examCode: 'GATE', targetYear: '2027' }, asLearner())).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'EXAM_NOT_AVAILABLE', message: expect.stringContaining('GATE') } });
    expect(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2031' }, asLearner())).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'EXAM_NOT_AVAILABLE' } });
    expect(rows.size).toBe(0);
  });

  it('passes Curriculum being unreachable on as that, and not as a fault in what the learner chose', async () => {
    const { update, state } = rig();
    state.resolveFails = applicationError('Unavailable', 'SOURCE_UNAVAILABLE', 'curriculum could not be read: X');
    expect(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner())).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE' } });
  });

  it('takes the year alone against the exam already chosen, and the exam alone against the year, and refuses either when nothing was chosen', async () => {
    const { update } = rig();
    expect(await update.handle({ targetYear: '2027' }, asLearner())).toMatchObject({ ok: false, error: { code: 'EXAM_CHOICE_INVALID' } });
    expect(await update.handle({ examCode: 'JEE_MAIN' }, asLearner())).toMatchObject({ ok: false, error: { code: 'EXAM_CHOICE_INVALID' } });
    value(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    expect(value(await update.handle({ targetYear: '2027' }, asLearner())).exam!.examCode).toBe('JEE_MAIN');
    expect(value(await update.handle({ examCode: 'JEE_MAIN' }, asLearner())).exam!.targetYear).toBe('2027');
    expect(await update.handle({ examCode: 42, targetYear: '2027' }, asLearner())).toMatchObject({ ok: false, error: { code: 'EXAM_CHOICE_INVALID' } });
  });

  it('takes the class, the prior score and its removal, and refuses what the form does not offer', async () => {
    const { update } = rig();
    expect(value(await update.handle({ currentClass: 'class_12' }, asLearner())).currentClass).toBe('class_12');
    expect(value(await update.handle({ priorScore: { value: 187, outOf: 300 } }, asLearner())).priorScore).toEqual({ value: 187, outOf: 300 });
    expect(value(await update.handle({ priorScore: null }, asLearner())).priorScore).toBeNull();
    expect(await update.handle({ currentClass: 'class_3' }, asLearner())).toMatchObject({ ok: false, error: { code: 'CLASS_INVALID' } });
    expect(await update.handle({ priorScore: { value: 400, outOf: 300 } }, asLearner())).toMatchObject({ ok: false, error: { code: 'PRIOR_SCORE_INVALID' } });
  });

  it('applies several steps in one save, over the version it read, and counts that one save', async () => {
    const { update, saves } = rig();
    const view = value(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12', priorScore: { value: 100, outOf: 300 } }, asLearner()));
    expect(view).toMatchObject({ currentClass: 'class_12', priorScore: { value: 100, outOf: 300 }, onboarding: { next: 'coverage' } });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.expected).toBeNull();
    expect(view.version).toBe(4); // a new profile is version 1, and each of the three steps is one more
  });

  it('a save made over a version that has moved on is a conflict, and changes nothing', async () => {
    const { update, rows, deps } = rig();
    value(await update.handle({ currentClass: 'class_11' }, asLearner()));
    const stale = new UpdateLearnerProfileHandler({ ...deps, profiles: { find: async () => ok({ ...rows.get(LEARNER)!, version: 1 }), save: deps.profiles.save } });
    expect(await stale.handle({ currentClass: 'class_12' }, asLearner())).toMatchObject({ ok: false, error: { kind: 'Conflict', code: 'PROFILE_CHANGED' } });
    expect(rows.get(LEARNER)!.currentClass).toBe('class_11');
  });

  it('saves nothing, and creates nothing, for a change with nothing in it', async () => {
    const { update, saves, rows } = rig();
    expect(value(await update.handle({}, asLearner())).onboarding.next).toBe('exam');
    expect(saves).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('resumes where the learner left: whatever order the steps were taken in, the next is the first one not done', async () => {
    const { update, get } = rig();
    value(await update.handle({ currentClass: 'class_12' }, asLearner()));
    expect(value(await get.handle({}, asLearner())).onboarding.next).toBe('exam');
    value(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    expect(value(await get.handle({}, asLearner())).onboarding.next).toBe('coverage');
  });
});

describe('the scope (FR-STU-02)', () => {
  async function chosen() {
    const r = rig();
    value(await r.update.handle({ examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12' }, asLearner()));
    return r;
  }

  it('needs the exam first, because the chapters are those of its syllabus', async () => {
    const { update } = rig();
    expect(await update.handle({ scopeNodeIds: ['mech'] }, asLearner())).toMatchObject({ ok: false, error: { kind: 'PreconditionFailed', code: 'EXAM_FIRST' } });
  });

  it('is declared against the taxonomy version in force, with the concepts the chapters stand for and the share of the syllabus they are', async () => {
    const { update, rows, state } = await chosen();
    const view = value(await update.handle({ scopeNodeIds: ['mech', 'optics'] }, asLearner()));
    expect(view.scope).toEqual({ status: 'in_force', taxonomyVersionId: T1, nodeIds: ['mech', 'optics'], conceptCount: 4, conceptTotal: 10, coverageFraction: 0.4 });
    expect(rows.get(LEARNER)!.scope!.conceptIdentityIds).toEqual(['mech-c1', 'mech-c2', 'optics-c1', 'optics-c2']);
    expect(view.onboarding.next).toBeNull();
    expect(state.calls).toContain('resolveScope tax-1 mech,optics');
  });

  it('is refused whole, naming the chapter, when one is not in the syllabus, and nothing is saved', async () => {
    const { update, rows } = await chosen();
    const before = rows.get(LEARNER)!;
    expect(await update.handle({ scopeNodeIds: ['mech', 'ghost'] }, asLearner())).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'SCOPE_NODES_UNKNOWN', message: expect.stringContaining('ghost') } });
    expect(rows.get(LEARNER)).toBe(before);
  });

  it('refuses a scope that is not a list of identifiers, or is empty', async () => {
    const { update } = await chosen();
    for (const bad of ['mech', 42, [1, 2], {}]) expect(await update.handle({ scopeNodeIds: bad }, asLearner()), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'SCOPE_INVALID' } });
    expect(await update.handle({ scopeNodeIds: [] }, asLearner())).toMatchObject({ ok: false, error: { code: 'SCOPE_INVALID' } });
  });

  it('is edited by declaring again, and taken away with null: everything is in scope again', async () => {
    const { update } = await chosen();
    value(await update.handle({ scopeNodeIds: ['mech'] }, asLearner()));
    expect(value(await update.handle({ scopeNodeIds: ['optics'] }, asLearner())).scope!.nodeIds).toEqual(['optics']);
    const cleared = value(await update.handle({ scopeNodeIds: null }, asLearner()));
    expect(cleared.scope).toBeNull();
    expect(cleared.onboarding.next).toBe('coverage');
  });

  it('offers the chapters of the syllabus in force, with the ones picked marked', async () => {
    const { update, options } = await chosen();
    value(await update.handle({ scopeNodeIds: ['mech'] }, asLearner()));
    expect(value(await options.handle({}, asLearner()))).toEqual({ taxonomyVersionId: T1, conceptTotal: 10, nodes: [{ nodeId: 'mech', parentNodeId: null, displayName: 'Mechanics', depth: 0 }], selected: ['mech'] });
  });

  it('refuses to offer chapters before an exam is chosen', async () => {
    expect(await rig().options.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'EXAM_FIRST' } });
  });
});

describe('a taxonomy version bump (FR-STU-02 rule 2)', () => {
  async function declaredThenBumped() {
    const r = rig();
    value(await r.update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    value(await r.update.handle({ scopeNodeIds: ['mech'] }, asLearner()));
    r.state.taxonomy = T2;
    return r;
  }

  it('reports the scope as needing review, and keeps it: nothing is guessed across the bump and nothing is deleted', async () => {
    const { get, rows } = await declaredThenBumped();
    const view = value(await get.handle({}, asLearner()));
    expect(view.scope).toMatchObject({ status: 'needs_review', taxonomyVersionId: T1, nodeIds: ['mech'] });
    expect(rows.get(LEARNER)!.scope!.taxonomyVersionId).toBe(T1);
  });

  it('offers the new version\'s chapters, with none marked as picked', async () => {
    const { options } = await declaredThenBumped();
    expect(value(await options.handle({}, asLearner()))).toMatchObject({ taxonomyVersionId: T2, selected: [] });
  });

  it('declares an edit against the new version, and brings the exam\'s versions up to date: the learner chose an exam and a year, not a version', async () => {
    const { update, rows } = await declaredThenBumped();
    const view = value(await update.handle({ scopeNodeIds: ['new-mech'] }, asLearner()));
    expect(view.scope).toMatchObject({ status: 'in_force', taxonomyVersionId: T2, nodeIds: ['new-mech'] });
    expect(rows.get(LEARNER)!.exam).toEqual({ examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'profile-for-tax-2', taxonomyVersionId: T2 });
  });

  it('keeps the exam\'s versions where they were when the scope is not what is edited', async () => {
    const { update, rows } = await declaredThenBumped();
    value(await update.handle({ currentClass: 'class_11' }, asLearner()));
    expect(rows.get(LEARNER)!.exam!.taxonomyVersionId).toBe(T1);
  });

  it('says nothing either way when Curriculum cannot be asked whether the version is still in force', async () => {
    const { get, state } = await declaredThenBumped();
    state.resolveFails = applicationError('Unavailable', 'SOURCE_UNAVAILABLE', 'x');
    expect(value(await get.handle({}, asLearner())).scope!.status).toBe('unchecked');
  });
});

describe('skipping (FR-STU-01 rule 2)', () => {
  it('is recorded on a learner who has done nothing, leaves the profile as it was, and still says what is to do', async () => {
    const { skip, rows } = rig();
    const view = value(await skip.handle({}, asLearner()));
    expect(view.onboarding).toMatchObject({ skipped: true, next: 'exam' });
    expect(rows.get(LEARNER)!.onboardingSkippedAt).toBe(NOW.toISOString());
    expect(view).toMatchObject({ exam: null, currentClass: null, scope: null });
  });

  it('is ended by the next thing the learner saves', async () => {
    const { skip, update } = rig();
    value(await skip.handle({}, asLearner()));
    expect(value(await update.handle({ currentClass: 'class_12' }, asLearner())).onboarding.skipped).toBe(false);
  });

  it('keeps what had been given before it', async () => {
    const { skip, update } = rig();
    value(await update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    expect(value(await skip.handle({}, asLearner()))).toMatchObject({ exam: { examCode: 'JEE_MAIN' }, onboarding: { skipped: true, next: 'class' } });
  });
});

describe('the exams to choose from', () => {
  it('are Curriculum\'s, and its failure is passed on', async () => {
    const { deps, state } = rig();
    const handler = new ListExamChoicesHandler(deps);
    expect(await handler.handle({}, asLearner())).toEqual({ ok: true, value: { exams: [{ examCode: 'JEE_MAIN', displayName: 'JEE Main', years: ['2027'] }] } });
    state.optionsFail = applicationError('Unavailable', 'SOURCE_UNAVAILABLE', 'x');
    expect(await handler.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });
});

describe('the scope as practice asks for it', () => {
  async function scoped() {
    const r = rig();
    value(await r.update.handle({ examCode: 'JEE_MAIN', targetYear: '2027' }, asLearner()));
    value(await r.update.handle({ scopeNodeIds: ['mech'] }, asLearner()));
    return { ...r, scope: new GetLearnerScopeHandler(r.deps) };
  }

  it('is the concepts of the scope for the version it was declared against', async () => {
    const { scope } = await scoped();
    expect(await scope.handle({ taxonomyVersionId: T1 }, asLearner())).toEqual({ ok: true, value: { conceptIdentityIds: ['mech-c1', 'mech-c2'] } });
  });

  it('is nothing — no filter — for another version, for a learner with no scope, and for one with no profile', async () => {
    const { scope, deps } = await scoped();
    expect(await scope.handle({ taxonomyVersionId: T2 }, asLearner())).toEqual({ ok: true, value: { conceptIdentityIds: null } });
    expect(await scope.handle({ taxonomyVersionId: T1 }, asLearner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))).toEqual({ ok: true, value: { conceptIdentityIds: null } });
    const update = new UpdateLearnerProfileHandler(deps);
    value(await update.handle({ scopeNodeIds: null }, asLearner()));
    expect(await scope.handle({ taxonomyVersionId: T1 }, asLearner())).toEqual({ ok: true, value: { conceptIdentityIds: null } });
  });

  it('is still nothing for a learner who skipped: skipping takes nothing away and puts nothing in the way', async () => {
    const { deps } = rig();
    value(await new SkipOnboardingHandler(deps).handle({}, asLearner()));
    expect(await new GetLearnerScopeHandler(deps).handle({ taxonomyVersionId: T1 }, asLearner())).toEqual({ ok: true, value: { conceptIdentityIds: null } });
  });

  it('is its own failure when the store cannot be read, and not a guess', async () => {
    const failing: LearnerProfileStore = { find: async () => err(applicationError('Unavailable', 'PROFILE_UNAVAILABLE', 'x')), save: async () => err(applicationError('Unavailable', 'PROFILE_UNAVAILABLE', 'x')) };
    expect(await new GetLearnerScopeHandler({ profiles: failing }).handle({ taxonomyVersionId: T1 }, asLearner())).toMatchObject({ ok: false, error: { code: 'PROFILE_UNAVAILABLE' } });
  });
});
