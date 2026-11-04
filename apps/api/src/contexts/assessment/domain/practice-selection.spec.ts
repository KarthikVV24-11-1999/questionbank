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

describe('the learner\'s declared scope', () => {
  const items = [cand(1), cand(2), cand(3, { conceptIdentityIds: [id(0xc0, 8), id(0xc0, 3)] })];

  it('leaves out an item with no concept in scope, and keeps one with any', () => {
    expect(choose(items, { scopeConceptIds: [id(0xc0, 2), id(0xc0, 3)] })).toEqual([v(2), v(3)]);
  });

  it('is no filter when absent, and no item at all when it is empty', () => {
    expect(choose(items)).toEqual([v(1), v(2), v(3)]);
    expect(choose(items, { scopeConceptIds: [] })).toEqual([]);
  });

  it('combines with the concepts a targeted run names, both having to hold', () => {
    expect(choose(items, { targetConceptIds: [id(0xc0, 1), id(0xc0, 2)], scopeConceptIds: [id(0xc0, 2), id(0xc0, 3)] })).toEqual([v(2)]);
  });
});

describe('the diagnostic takes one item for each concept before a second for any (M8-31, FR-STU-03 rule 1)', () => {
  const breadth = (over: Record<string, unknown> = {}) => policy({ selectionStrategy: 'breadth', scopeFilter: {}, ...over });
  const chooseBreadth = (candidates: AssemblyCandidate[], over: Partial<Parameters<typeof selectPracticeItems>[0]> = {}) => choose(candidates, { policy: breadth(), ...over });
  const c = (n: number) => id(0xc0, n);
  /** Items 1..k about the concept n, numbered from `from`. */
  const about = (concept: number, from: number, k: number): AssemblyCandidate[] => Array.from({ length: k }, (_, i) => cand(from + i, { conceptIdentityIds: [c(concept)] }));

  it('gives every concept an item before any concept a second, concepts in identifier order, items within a concept in the usual order', () => {
    const items = [...about(3, 30, 2), ...about(1, 10, 2), ...about(2, 20, 2)];
    expect(chooseBreadth(items, { count: 6 })).toEqual([v(10), v(20), v(30), v(11), v(21), v(31)]);
    expect(chooseBreadth(items, { count: 4 })).toEqual([v(10), v(20), v(30), v(11)]);
  });

  it('reaches every concept before taking a second from the rich one: the counts per concept, and not only the length', () => {
    const items = [...about(1, 10, 8), ...about(2, 20, 1), ...about(3, 30, 1), ...about(4, 40, 1)];
    const chosen = selectPracticeItems({ candidates: items, policy: breadth(), seenItemIds: new Set(), inRunItemIds: new Set(), exposure: new Map(), count: 6 });
    const perConcept = new Map<string, number>();
    for (const item of chosen) for (const concept of item.conceptIdentityIds) perConcept.set(concept, (perConcept.get(concept) ?? 0) + 1);
    expect([...perConcept].sort()).toEqual([[c(1), 3], [c(2), 1], [c(3), 1], [c(4), 1]]);
    expect(chosen).toHaveLength(6);
    // and with fewer places than concepts, no concept has a second
    const short = selectPracticeItems({ candidates: items, policy: breadth(), seenItemIds: new Set(), inRunItemIds: new Set(), exposure: new Map(), count: 3 });
    expect(short.flatMap((item) => item.conceptIdentityIds)).toEqual([c(1), c(2), c(3)]);
  });

  it('takes an item about several concepts once, and counts it for one concept only: where every item covers two, the run still spreads over all four', () => {
    const items = [
      ...[1, 2, 3, 4].map((n) => cand(n, { conceptIdentityIds: [c(1), c(2)] })),
      ...[5, 6, 7, 8].map((n) => cand(n, { conceptIdentityIds: [c(3), c(4)] })),
    ];
    const chosen = selectPracticeItems({ candidates: items, policy: breadth(), seenItemIds: new Set(), inRunItemIds: new Set(), exposure: new Map(), count: 4 });
    expect(chosen.map((item) => item.itemVersionId)).toEqual([v(1), v(2), v(5), v(6)]);
    expect(new Set(chosen.flatMap((item) => item.conceptIdentityIds))).toEqual(new Set([c(1), c(2), c(3), c(4)]));
    // taken once: no item twice, however many of its concepts had a turn
    expect(new Set(chosen.map((item) => item.itemId)).size).toBe(chosen.length);
    // the same corpus in the filtered order would have filled two concepts and stopped
    expect(choose(items, { count: 4 })).toEqual([v(1), v(2), v(3), v(4)]);
  });

  it('prefers the least exposed within a concept, as every other order does', () => {
    const items = [...about(1, 10, 3), ...about(2, 20, 1)];
    expect(chooseBreadth(items, { count: 2, exposure: new Map([[v(10), 5], [v(11), 0], [v(12), 2]]) })).toEqual([v(11), v(20)]);
  });

  it('draws only on the concepts in force: the learner\'s declared scope, the policy\'s own concepts, and the ones in both when both are given', () => {
    const items = [...about(1, 10, 2), ...about(2, 20, 2), ...about(3, 30, 2)];
    expect(chooseBreadth(items, { scopeConceptIds: [c(3), c(1)] })).toEqual([v(10), v(30), v(11), v(31)]);
    expect(choose(items, { policy: breadth({ scopeFilter: { conceptIdentityIds: [c(2)] } }) })).toEqual([v(20), v(21)]);
    expect(choose(items, { policy: breadth({ scopeFilter: { conceptIdentityIds: [c(1), c(2)] } }), scopeConceptIds: [c(2), c(3)] })).toEqual([v(20), v(21)]);
  });

  it('does not take an item that is about something the policy names and something else the scope names, and nothing in force in common', () => {
    const mixed = cand(1, { conceptIdentityIds: [c(1), c(2)] });
    const wanted = cand(2, { conceptIdentityIds: [c(1)] });
    expect(choose([mixed, wanted], { policy: breadth({ scopeFilter: { conceptIdentityIds: [c(1)] } }), scopeConceptIds: [c(2)] })).toEqual([]);
  });

  it('ends when no concept has an item left, short of the count', () => {
    expect(chooseBreadth([...about(1, 10, 1), ...about(2, 20, 2)], { count: 9 })).toEqual([v(10), v(20), v(21)]);
    expect(chooseBreadth([], { count: 5 })).toEqual([]);
  });

  it('gives an item once even where the catalogue lists two versions of it, and leaves out what eligibility leaves out', () => {
    const twice = [cand(1, { itemVersionId: v(1) }), cand(1, { itemVersionId: v(2), conceptIdentityIds: [c(1)] })];
    expect(chooseBreadth(twice.map((item) => ({ ...item, conceptIdentityIds: [c(1)] })))).toHaveLength(1);
    expect(chooseBreadth([cand(1), cand(2, { isAnchor: true, anchorExposureCap: 4 }), cand(3, { isPublished: false })])).toEqual([v(1)]);
    expect(chooseBreadth([cand(1), cand(2)], { inRunItemIds: new Set([id(TAG.item, 1)]) })).toEqual([v(2)]);
  });

  it('chooses the same items from the same inputs in any order, and reads no clock and no random source', () => {
    const items = [...about(2, 20, 3), ...about(1, 10, 3), ...about(3, 30, 3)];
    const forward = chooseBreadth(items, { count: 5 });
    expect(chooseBreadth([...items].reverse(), { count: 5 })).toEqual(forward);
    expect(chooseBreadth([...items].reverse(), { count: 5 })).toEqual(chooseBreadth(items, { count: 5 }));
  });
});
