import { describe, expect, it } from 'vitest';
import { expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import type { AssemblyCandidate } from './assembly.js';
import { createPracticePolicy, deriveDeliveryPolicy, practicePolicyOf } from './delivery-policy.js';
import { selectPracticeItems } from './practice-selection.js';

const cand = (n: number, o: Partial<AssemblyCandidate> = {}): AssemblyCandidate => ({
  itemId: id(TAG.item, n),
  itemVersionId: id(TAG.itemVersion, n),
  itemType: 'SINGLE_CORRECT_MCQ',
  difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)],
  stimulusVersionId: null,
  isPublished: true,
  isAnchor: false,
  anchorExposureCap: null,
  ...o,
});
const policy = (over: Record<string, unknown> = {}) =>
  expectValue(createPracticePolicy({ selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, ...over }));
const choose = (candidates: AssemblyCandidate[], over: Partial<Parameters<typeof selectPracticeItems>[0]> = {}) =>
  selectPracticeItems({ candidates, policy: policy(), seenItemIds: new Set(), inRunItemIds: new Set(), exposure: new Map(), count: 10, ...over }).map((c) => c.itemVersionId);
const v = (n: number) => id(TAG.itemVersion, n);

describe('what a practice run is given', () => {
  it('is only published items, never an anchor', () => {
    expect(choose([cand(1), cand(2, { isPublished: false }), cand(3, { isAnchor: true, anchorExposureCap: 4 })])).toEqual([v(1)]);
  });

  it('honours the difficulty band and the item types, and an empty scope means every eligible item', () => {
    const items = [cand(1), cand(2, { difficultyBand: 'advanced' }), cand(3, { itemType: 'NUMERIC' })];
    expect(choose(items, { policy: policy({ difficultyBand: 'advanced' }) })).toEqual([v(2)]);
    expect(choose(items, { policy: policy({ scopeFilter: { itemTypes: ['NUMERIC'] } }) })).toEqual([v(3)]);
    expect(choose(items, { policy: policy({ scopeFilter: { itemTypes: [] }, difficultyBand: 'moderate' }) })).toEqual([v(1), v(3)]);
  });

  it('draws from the policy\'s concepts, or from the concepts Learning named, which replace them', () => {
    const items = [cand(1), cand(2), cand(3)];
    expect(choose(items, { policy: policy({ scopeFilter: { conceptIdentityIds: [id(0xc0, 2)] } }) })).toEqual([v(2)]);
    expect(choose(items, { policy: policy({ selectionStrategy: 'targeted', scopeFilter: {} }), targetConceptIds: [id(0xc0, 3), id(0xc0, 1)] })).toEqual([v(1), v(3)]);
  });

  it('leaves out what the learner has seen only when the policy says so, and always what is already in the run', () => {
    const items = [cand(1), cand(2), cand(3)];
    const seen = new Set([id(TAG.item, 1)]);
    expect(choose(items, { seenItemIds: seen })).toEqual([v(2), v(3)]);
    expect(choose(items, { seenItemIds: seen, policy: policy({ excludeRecentlySeen: false }) })).toEqual([v(1), v(2), v(3)]);
    expect(choose(items, { inRunItemIds: seen, policy: policy({ excludeRecentlySeen: false }) })).toEqual([v(2), v(3)]);
  });

  it('prefers the least exposed, breaks ties by version id, stops at the count, and gives an item once', () => {
    const items = [cand(3), cand(1), cand(2), cand(9, { itemId: id(TAG.item, 1), itemVersionId: v(9) })];
    const exposure = new Map([[v(1), 5], [v(9), 7], [v(3), 1]]);
    expect(choose(items, { exposure, count: 2 })).toEqual([v(2), v(3)]);
    expect(choose(items, { exposure })).toEqual([v(2), v(3), v(1)]);
  });

  it('chooses the same items from the same inputs, in any input order', () => {
    const items = [cand(1), cand(2), cand(3), cand(4)];
    expect(choose([...items].reverse())).toEqual(choose(items));
  });
});

describe('the practice policy a run pinned is the one it is grown under', () => {
  it('reads back from the delivery document exactly as it was derived', () => {
    const original = policy({ selectionStrategy: 'targeted', scopeFilter: { conceptIdentityIds: [id(0xc0, 1)], itemTypes: ['NUMERIC'] }, difficultyBand: 'challenging', excludeRecentlySeen: false });
    const document = deriveDeliveryPolicy({ kind: 'practice', policy: original }).document;
    expect(expectValue(practicePolicyOf(document)!)).toEqual(original);
  });

  it('is nothing for a mock\'s document', () => {
    const profile = { totalDurationMinutes: 180, sectionLocking: false, autoSubmitOnExpiry: true, crossSectionNavigation: true, allowMarkForReview: true, allowAnswerChange: true, allowClearResponse: true };
    expect(practicePolicyOf(deriveDeliveryPolicy({ kind: 'profile', profile }).document)).toBeNull();
  });
});
