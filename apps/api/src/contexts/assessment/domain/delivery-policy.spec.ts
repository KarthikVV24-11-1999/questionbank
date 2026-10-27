import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { DIFFICULTY_BANDS, SELECTION_STRATEGIES, createPracticePolicy, deriveDeliveryPolicy, type PracticePolicyProps } from './delivery-policy.js';

const CONCEPT = '00000000-0000-4000-8000-0000000000c1';
const PROFILE = { totalDurationMinutes: 180, sectionLocking: false, autoSubmitOnExpiry: true, crossSectionNavigation: true, allowMarkForReview: true, allowAnswerChange: true, allowClearResponse: false };
const filtered = (over: Partial<PracticePolicyProps> = {}): PracticePolicyProps => ({ selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, ...over });

describe('PracticePolicy', () => {
  it('offers three strategies, and adaptive is not one of them', () => {
    expect([...SELECTION_STRATEGIES]).toEqual(['filtered', 'targeted', 'spaced_review']);
    expect(expectError(createPracticePolicy({ selectionStrategy: 'adaptive' })).code).toBe('PRACTICE_ADAPTIVE_NOT_AVAILABLE');
    expect(expectError(createPracticePolicy({ selectionStrategy: 'roulette' })).code).toBe('PRACTICE_STRATEGY_INVALID');
  });

  it('builds each strategy, with immediate feedback and pausable fixed, and excludes the recently seen by default', () => {
    for (const strategy of ['targeted', 'spaced_review']) {
      const policy = expectValue(createPracticePolicy({ selectionStrategy: strategy }));
      expect([policy.selectionStrategy, policy.feedbackMode, policy.pausable, policy.excludeRecentlySeen]).toEqual([strategy, 'immediate', true, true]);
    }
    const policy = expectValue(createPracticePolicy(filtered({ scopeFilter: { conceptIdentityIds: [CONCEPT], itemTypes: ['single_choice'] }, difficultyBand: 'advanced', excludeRecentlySeen: false })));
    expect(policy.scopeFilter).toEqual({ conceptIdentityIds: [CONCEPT], subject: null, itemTypes: ['single_choice'] });
    expect([policy.difficultyBand, policy.excludeRecentlySeen]).toEqual(['advanced', false]);
  });

  it.each([
    ['a filtered run with nothing to filter by', { selectionStrategy: 'filtered' }, 'PRACTICE_FILTER_EMPTY'],
    ['a concept that is not an identity', filtered({ scopeFilter: { conceptIdentityIds: ['nope'] } }), 'PRACTICE_SCOPE_INVALID'],
    ['a concept named twice', filtered({ scopeFilter: { conceptIdentityIds: [CONCEPT, CONCEPT] } }), 'PRACTICE_SCOPE_INVALID'],
    ['a blank subject', filtered({ scopeFilter: { subject: '  ' } }), 'PRACTICE_SCOPE_INVALID'],
    ['a band that is not authored', filtered({ difficultyBand: 'hard' }), 'PRACTICE_BAND_INVALID'],
    ['deferred feedback', filtered({ feedbackMode: 'deferred' }), 'PRACTICE_FLAGS_INVALID'],
    ['a run that cannot be paused', filtered({ pausable: false }), 'PRACTICE_FLAGS_INVALID'],
  ] as const)('refuses %s', (_name, props, code) => {
    expect(expectError(createPracticePolicy(props)).code).toBe(code);
  });

  it('names the four authored bands, the same four content publishes (read as text: assessment imports nothing from content)', () => {
    expect([...DIFFICULTY_BANDS]).toEqual(['foundational', 'moderate', 'challenging', 'advanced']);
    const source = readFileSync(new URL('../../content/domain/item-version.ts', import.meta.url), 'utf8');
    const published = /export const DIFFICULTY_BANDS = \[([^\]]+)\]/u.exec(source)?.[1]?.match(/'([^']+)'/gu)?.map((name) => name.slice(1, -1));
    expect(published).toEqual([...DIFFICULTY_BANDS]);
  });
});

describe('the derivation of a DeliveryPolicy, the one place either input is read', () => {
  it('derives a mock from its profile: timed, with the profile\'s duration, feedback deferred, not pausable', () => {
    const derived = deriveDeliveryPolicy({ kind: 'profile', profile: PROFILE });
    expect([derived.isTimed, derived.durationMs]).toEqual([true, 10_800_000]);
    expect(derived.document).toEqual({
      timing: { totalDurationMinutes: 180, sectionLocking: false, autoSubmitOnExpiry: true },
      navigation: { crossSectionNavigation: true, allowMarkForReview: true, allowAnswerChange: true, allowClearResponse: false },
      feedbackMode: 'deferred',
      pausable: false,
    });
  });

  it('derives practice from its policy: untimed, no duration, immediate feedback, pausable, and the policy it came from', () => {
    const policy = expectValue(createPracticePolicy(filtered({ difficultyBand: 'moderate' })));
    const derived = deriveDeliveryPolicy({ kind: 'practice', policy });
    expect([derived.isTimed, derived.durationMs]).toEqual([false, null]);
    expect(derived.document).toMatchObject({ timing: { untimed: true }, feedbackMode: 'immediate', pausable: true });
    expect(derived.document['practice']).toEqual({
      selectionStrategy: 'filtered',
      scopeFilter: { conceptIdentityIds: [], subject: 'physics', itemTypes: [] },
      difficultyBand: 'moderate',
      excludeRecentlySeen: true,
    });
  });

  it('says timed and duration together, so the two columns that follow it cannot disagree', () => {
    for (const source of [{ kind: 'profile', profile: PROFILE }, { kind: 'practice', policy: expectValue(createPracticePolicy(filtered())) }] as const) {
      const derived = deriveDeliveryPolicy(source);
      expect(derived.isTimed).toBe(derived.durationMs !== null);
    }
  });
});
