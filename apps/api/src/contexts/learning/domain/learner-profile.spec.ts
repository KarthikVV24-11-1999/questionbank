import { describe, expect, it } from 'vitest';
import { chooseExam, clearScope, conceptsInScope, declareScope, newProfile, onboardingState, scopeStatus, setCurrentClass, setPriorScore, skipOnboarding, MAX_SCOPE_NODES, type DeclaredScope, type ExamChoice, type LearnerProfile } from './learner-profile.js';

const LEARNER = '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a';
const T0 = '2026-11-04T09:00:00.000Z';
const T1 = '2026-11-04T09:05:00.000Z';
const TAXONOMY = '11111111-1111-4111-8111-111111111111';
const OTHER_TAXONOMY = '22222222-2222-4222-8222-222222222222';
const CHOICE: ExamChoice = { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: '33333333-3333-4333-8333-333333333333', taxonomyVersionId: TAXONOMY };
const SCOPE: DeclaredScope = { taxonomyVersionId: TAXONOMY, nodeIds: ['a', 'b'], conceptIdentityIds: ['c1', 'c2', 'c3'], conceptTotal: 10 };
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const blank = (): LearnerProfile => newProfile(LEARNER, T0);

describe('a new profile is empty and valid', () => {
  it('holds only whose it is and when it began, at version 1, with nothing skipped', () => {
    expect(blank()).toEqual({ learnerRef: LEARNER, exam: null, currentClass: null, priorScore: null, scope: null, onboardingSkippedAt: null, version: 1, createdAt: T0, updatedAt: T0 });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(blank())).toBe(true);
  });
});

describe('choosing the exam', () => {
  it('keeps the exam, the year and the versions they resolved to, and counts a version', () => {
    const profile = value(chooseExam(blank(), CHOICE, T1));
    expect(profile.exam).toEqual(CHOICE);
    expect([profile.version, profile.updatedAt, profile.createdAt]).toEqual([2, T1, T0]);
  });

  it('refuses an exam with no code, and a year that is not one', () => {
    for (const bad of [{ ...CHOICE, examCode: '  ' }, { ...CHOICE, targetYear: '27' }, { ...CHOICE, targetYear: '2027-2028' }, { ...CHOICE, targetYear: 'next year' }]) {
      expect(chooseExam(blank(), bad, T1), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'EXAM_CHOICE_INVALID' } });
    }
    expect(chooseExam(blank(), { ...CHOICE, targetYear: '2026-27' }, T1).ok).toBe(true);
  });

  it('does not delete a scope declared against another taxonomy version: it stays, and is reported as needing review', () => {
    const scoped = value(declareScope(value(chooseExam(blank(), CHOICE, T0)), SCOPE, T0));
    const changed = value(chooseExam(scoped, { ...CHOICE, examCode: 'NEET', taxonomyVersionId: OTHER_TAXONOMY }, T1));
    expect(changed.scope).toEqual(SCOPE);
    expect(scopeStatus(changed, OTHER_TAXONOMY)).toBe('needs_review');
  });
});

describe('the current class', () => {
  it('is one of the three the form asks for', () => {
    for (const ok of ['class_11', 'class_12', 'repeater']) expect(value(setCurrentClass(blank(), ok, T1)).currentClass).toBe(ok);
    for (const bad of ['class_10', '', null, undefined, 12]) expect(setCurrentClass(blank(), bad, T1), String(bad)).toMatchObject({ ok: false, error: { code: 'CLASS_INVALID' } });
  });
});

describe('the optional prior score', () => {
  it('is a score no more than its maximum, with a maximum above zero', () => {
    expect(value(setPriorScore(blank(), { value: 187, outOf: 300 }, T1)).priorScore).toEqual({ value: 187, outOf: 300 });
    expect(value(setPriorScore(blank(), { value: 0, outOf: 1 }, T1)).priorScore).toEqual({ value: 0, outOf: 1 });
    expect(value(setPriorScore(blank(), { value: 300, outOf: 300 }, T1)).priorScore).toEqual({ value: 300, outOf: 300 });
    for (const bad of [{ value: 301, outOf: 300 }, { value: -1, outOf: 300 }, { value: 1, outOf: 0 }, { value: 1, outOf: -5 }, { value: Number.NaN, outOf: 10 }, { value: 1, outOf: Number.POSITIVE_INFINITY }, { value: '5', outOf: 10 }, { value: 5 }, {}, undefined, { value: 1, outOf: 100_001 }]) {
      expect(setPriorScore(blank(), bad, T1), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'PRIOR_SCORE_INVALID' } });
    }
  });

  it('can be taken away with null, and only with null', () => {
    const given = value(setPriorScore(blank(), { value: 5, outOf: 10 }, T0));
    expect(value(setPriorScore(given, null, T1)).priorScore).toBeNull();
  });
});

describe('the scope', () => {
  it('is declared against a taxonomy version, with its chapters and the concepts they stand for', () => {
    expect(value(declareScope(blank(), SCOPE, T1)).scope).toEqual(SCOPE);
  });

  it('refuses a scope with nothing in it, with a chapter or a concept twice, or with more concepts than the syllabus has', () => {
    for (const bad of [
      { ...SCOPE, nodeIds: [] },
      { ...SCOPE, nodeIds: ['a', 'a'] },
      { ...SCOPE, conceptIdentityIds: [] },
      { ...SCOPE, conceptIdentityIds: ['c1', 'c1'] },
      { ...SCOPE, conceptTotal: 2 },
      { ...SCOPE, conceptTotal: 3.5 },
      { ...SCOPE, nodeIds: Array.from({ length: MAX_SCOPE_NODES + 1 }, (_, n) => `n${n}`) },
    ]) {
      expect(declareScope(blank(), bad, T1), JSON.stringify(bad).slice(0, 80)).toMatchObject({ ok: false, error: { code: 'SCOPE_INVALID' } });
    }
    expect(declareScope(blank(), { ...SCOPE, conceptTotal: 3 }, T1).ok).toBe(true);
    expect(declareScope(blank(), { ...SCOPE, nodeIds: Array.from({ length: MAX_SCOPE_NODES }, (_, n) => `n${n}`) }, T1).ok).toBe(true);
  });

  it('is replaced by the next declaration, and cleared on request', () => {
    const first = value(declareScope(blank(), SCOPE, T0));
    const second = value(declareScope(first, { ...SCOPE, nodeIds: ['z'], conceptIdentityIds: ['c9'] }, T1));
    expect(second.scope!.nodeIds).toEqual(['z']);
    expect(clearScope(second, T1).scope).toBeNull();
  });

  it('applies to the taxonomy version it was declared against and to no other', () => {
    const profile = value(declareScope(blank(), SCOPE, T0));
    expect(scopeStatus(profile, TAXONOMY)).toBe('in_force');
    expect(scopeStatus(profile, OTHER_TAXONOMY)).toBe('needs_review');
    expect(scopeStatus(profile, null)).toBe('needs_review');
    expect(scopeStatus(blank(), TAXONOMY)).toBe('none');
  });

  it('gives the concepts in scope for its own version, and none where no scope is in force: nothing is filtered', () => {
    const profile = value(declareScope(blank(), SCOPE, T0));
    expect([...conceptsInScope(profile, TAXONOMY)!].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(conceptsInScope(profile, OTHER_TAXONOMY)).toBeNull();
    expect(conceptsInScope(blank(), TAXONOMY)).toBeNull();
  });
});

describe('where the learner was is read from what the profile holds (FR-STU-01 rule 2)', () => {
  it('starts at the exam and goes to the class, then the coverage, then nothing', () => {
    let profile = blank();
    expect(onboardingState(profile).next).toBe('exam');
    profile = value(chooseExam(profile, CHOICE, T1));
    expect(onboardingState(profile).next).toBe('class');
    profile = value(setCurrentClass(profile, 'class_12', T1));
    expect(onboardingState(profile).next).toBe('coverage');
    profile = value(declareScope(profile, SCOPE, T1));
    expect(onboardingState(profile).next).toBeNull();
  });

  it('does not depend on the order things were filled in: a learner who did the class first is still asked for the exam', () => {
    const profile = value(setCurrentClass(blank(), 'class_11', T1));
    expect(onboardingState(profile).next).toBe('exam');
    expect(onboardingState(profile).steps.map((entry) => `${entry.step}:${entry.state}`)).toEqual(['exam:pending', 'class:done', 'coverage:pending', 'prior_score:optional']);
  });

  it('never asks for the prior score: it is optional, given or not', () => {
    const profile = value(declareScope(value(setCurrentClass(value(chooseExam(blank(), CHOICE, T0)), 'class_12', T0)), SCOPE, T0));
    expect(onboardingState(profile).next).toBeNull();
    expect(onboardingState(profile).steps.at(-1)).toEqual({ step: 'prior_score', state: 'optional' });
    expect(onboardingState(value(setPriorScore(profile, { value: 1, outOf: 2 }, T1))).steps.at(-1)).toEqual({ step: 'prior_score', state: 'done' });
  });

  it('is the same state however many times it is asked: it is a function of the profile', () => {
    const profile = value(chooseExam(blank(), CHOICE, T0));
    expect(onboardingState(profile)).toEqual(onboardingState(profile));
  });
});

describe('skipping', () => {
  it('is recorded, leaves the profile as partial as it was, and does not change what is to do', () => {
    const skipped = skipOnboarding(blank(), T1);
    expect(onboardingState(skipped)).toMatchObject({ skipped: true, next: 'exam' });
    expect(skipped).toMatchObject({ exam: null, currentClass: null, scope: null, onboardingSkippedAt: T1, version: 2 });
  });

  it('ends with the next thing the learner saves, whichever it is: they have carried on', () => {
    const skipped = skipOnboarding(blank(), T1);
    for (const next of [value(chooseExam(skipped, CHOICE, T1)), value(setCurrentClass(skipped, 'class_11', T1)), value(setPriorScore(skipped, null, T1)), value(declareScope(skipped, SCOPE, T1)), clearScope(skipped, T1)]) {
      expect(onboardingState(next).skipped).toBe(false);
      expect(next.onboardingSkippedAt).toBeNull();
    }
  });
});
