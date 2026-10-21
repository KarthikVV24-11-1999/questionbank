import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import {
  HARD_CONSTRAINTS,
  assembleForm,
  requiredAnchors,
  violatedConstraints,
  type AssemblyCandidate,
  type AssemblyInput,
  type HardConstraint,
} from './assembly.js';
import { createBlueprint, type Blueprint, type BlueprintDifficultyBand, type BlueprintItemType, type SectionBlueprint } from './blueprint.js';
import { seeded, shuffled } from '../../../testing/random.js';

const slotId = (section: number, slot: number) => id(TAG.slot, section * 100 + slot);

let counter = 0;
function cand(n: number, overrides: Partial<AssemblyCandidate> = {}): AssemblyCandidate {
  counter += 1;
  return {
    itemId: id(TAG.item, n),
    itemVersionId: id(TAG.itemVersion, n),
    itemType: 'SINGLE_CORRECT_MCQ',
    difficultyBand: 'moderate',
    conceptIdentityIds: [id(0xc0, n)],
    stimulusVersionId: null,
    isPublished: true,
    isAnchor: false,
    anchorExposureCap: null,
    ...overrides,
  };
}

const anchor = (n: number, overrides: Partial<AssemblyCandidate> = {}) => cand(n, { isAnchor: true, anchorExposureCap: 10, ...overrides });

function section(ordinal: number, mix: Partial<Record<BlueprintItemType, number>>, bands?: Partial<Record<BlueprintDifficultyBand, number>>, marks = 4): SectionBlueprint {
  const count = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
  return { ordinal, sectionSpecRef: `s${ordinal}`, itemCount: count, typeMix: mix, marksPerItem: marks, difficultyTarget: bands ?? { moderate: count }};
}

function blueprint(sections: SectionBlueprint[], overrides: Partial<Blueprint> = {}): Blueprint {
  return expectValue(
    createBlueprint({
      examProfileVersionId: id(TAG.profile),
      formType: 'mock',
      totalMarks: sections.reduce((sum, s) => sum + s.itemCount * s.marksPerItem, 0),
      difficultyTolerance: 0,
      sections,
      ...overrides,
    }),
  );
}

function input(bp: Blueprint, candidates: AssemblyCandidate[], overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return { blueprint: bp, candidates, exposure: new Map(), nearDuplicates: new Map(), newSlotId: slotId, ...overrides };
}

const chosenItems = (assembled: ReturnType<typeof assembleForm>) =>
  expectValue(assembled).sections.flatMap((s) => s.slots.map((slot) => slot.itemId));

/** Six single-answer items, one of them an anchor (1 of 6 is 16%). */
const easyPool = () => [anchor(1), cand(2), cand(3), cand(4), cand(5), cand(6), cand(7)];
const easyBlueprint = () => blueprint([section(1, { SINGLE_CORRECT_MCQ: 3 }), section(2, { SINGLE_CORRECT_MCQ: 3 })]);

describe('a successful assembly', () => {
  it('fills every slot from the pool, satisfying every hard constraint by an independent check', () => {
    const request = input(easyBlueprint(), easyPool());
    const assembled = expectValue(assembleForm(request));
    expect(assembled.sections.map((s) => s.slots.length)).toEqual([3, 3]);
    expect(assembled.sections.map((s) => s.sectionSpecRef)).toEqual(['s1', 's2']);
    expect(violatedConstraints(request, assembled.sections)).toEqual([]);
    const slots = assembled.sections.flatMap((s) => s.slots);
    expect(slots.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slots.every((s) => s.marksAvailable === 4)).toBe(true);
    expect(slots.some((s) => s.isAnchor)).toBe(true);
    expect(new Set(slots.map((s) => s.slotId)).size).toBe(6);
    expect(Object.isFrozen(assembled)).toBe(true);
  });

  it('puts items of each type where the mix says, in type order within a section', () => {
    const pool = [anchor(1, { itemType: 'NUMERIC' }), cand(2, { itemType: 'NUMERIC' }), cand(3), cand(4), cand(5, { itemType: 'MATCHING' })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2, MATCHING: 1, NUMERIC: 2 })]);
    const assembled = expectValue(assembleForm(input(bp, pool)));
    const byId = new Map(pool.map((c) => [c.itemId, c.itemType]));
    expect(assembled.sections[0]!.slots.map((s) => byId.get(s.itemId))).toEqual(['SINGLE_CORRECT_MCQ', 'SINGLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC', 'NUMERIC']);
  });

  it('carries each chosen version, its stimulus and its anchor flag onto the slot', () => {
    const pool = [anchor(1, { stimulusVersionId: id(TAG.stimulus, 1) }), cand(2), cand(3), cand(4), cand(5), cand(6)];
    const assembled = expectValue(assembleForm(input(blueprint([section(1, { SINGLE_CORRECT_MCQ: 6 })]), pool)));
    const slot = assembled.sections[0]!.slots.find((s) => s.itemId === id(TAG.item, 1))!;
    expect(slot.itemVersionId).toBe(id(TAG.itemVersion, 1));
    expect(slot.stimulusVersionId).toBe(id(TAG.stimulus, 1));
    expect(slot.isAnchor).toBe(true);
  });

  it('numbers slots across sections, so no two in the form share an ordinal', () => {
    const bp = blueprint([section(5, { SINGLE_CORRECT_MCQ: 2 }), section(2, { SINGLE_CORRECT_MCQ: 2 })]);
    const assembled = expectValue(assembleForm(input(bp, easyPool())));
    expect(assembled.sections.map((s) => s.ordinal)).toEqual([2, 5]);
    expect(assembled.sections.flatMap((s) => s.slots.map((slot) => slot.ordinal))).toEqual([1, 2, 3, 4]);
  });
});

describe('every hard constraint fails rather than compromises, and is named', () => {
  const refusal = (request: AssemblyInput) => expectError(assembleForm(request));

  it('ITEM_COUNT — too few items to fill the slots', () => {
    const error = refusal(input(easyBlueprint(), easyPool().slice(0, 4)));
    expect(error.constraint).toBe('ITEM_COUNT');
    expect(error.code).toBe('ASSEMBLY_INFEASIBLE');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('ITEM_COUNT — enough published items, but too few once anchors past their cap are set aside', () => {
    const pool = [anchor(1), cand(2), cand(3)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 3 })]);
    const error = refusal(input(bp, pool, { exposure: new Map([[id(TAG.itemVersion, 1), 10]]) }));
    expect(error.constraint).toBe('ITEM_COUNT');
  });

  it('TYPE_MIX — plenty of items, none of the type asked for', () => {
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2, NUMERIC: 1 })]);
    const error = refusal(input(bp, [anchor(1), cand(2), cand(3), cand(4), cand(5)]));
    expect(error.constraint).toBe('TYPE_MIX');
    expect(error.message).toContain('NUMERIC');
  });

  it('TOTAL_MARKS — a blueprint whose sections are worth other than it says', () => {
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 3 }), section(2, { SINGLE_CORRECT_MCQ: 3 })], { totalMarks: 100 });
    const error = refusal(input(bp, easyPool()));
    expect(error.constraint).toBe('TOTAL_MARKS');
    expect(error.message).toContain('24');
    expect(error.message).toContain('100');
  });

  it('PUBLISHED_ONLY — enough candidates, but not enough of them published', () => {
    const pool = easyPool().map((c, i) => (i < 3 ? { ...c, isPublished: false } : c));
    const error = refusal(input(easyBlueprint(), pool));
    expect(error.constraint).toBe('PUBLISHED_ONLY');
  });

  it('PUBLISHED_ONLY — never chooses an unpublished item even when it would complete the form', () => {
    const pool = [...easyPool().slice(0, 5), { ...cand(9), isPublished: false }];
    expect(refusal(input(easyBlueprint(), pool)).constraint).toBe('PUBLISHED_ONLY');
  });

  it('STIMULUS_SPLIT — the only two items share a passage and would land in different sections', () => {
    const shared = id(TAG.stimulus, 1);
    const pool = [anchor(1, { stimulusVersionId: shared }), cand(2, { stimulusVersionId: shared })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 1 }), section(2, { SINGLE_CORRECT_MCQ: 1 })]);
    expect(refusal(input(bp, pool)).constraint).toBe('STIMULUS_SPLIT');
  });

  it('...but items sharing a stimulus may sit together in ONE section', () => {
    const shared = id(TAG.stimulus, 1);
    const pool = [anchor(1, { stimulusVersionId: shared }), cand(2, { stimulusVersionId: shared })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 })]);
    const request = input(bp, pool);
    expect(violatedConstraints(request, expectValue(assembleForm(request)).sections)).toEqual([]);
  });

  it('NEAR_DUPLICATE — the only candidates are near-duplicates of each other, in either direction of the map', () => {
    const pool = [anchor(1), cand(2)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 })]);
    for (const map of [
      new Map([[id(TAG.itemVersion, 1), new Set([id(TAG.itemVersion, 2)])]]),
      new Map([[id(TAG.itemVersion, 2), new Set([id(TAG.itemVersion, 1)])]]),
    ]) {
      expect(refusal(input(bp, pool, { nearDuplicates: map })).constraint).toBe('NEAR_DUPLICATE');
    }
  });

  it('ANCHOR_FLOOR — a pool with no anchors, and one whose anchors are all past their cap', () => {
    const noAnchors = [cand(1), cand(2), cand(3), cand(4), cand(5), cand(6)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 6 })]);
    const none = refusal(input(bp, noAnchors));
    expect(none.constraint).toBe('ANCHOR_FLOOR');
    expect(none.message).toContain('1 anchor items are needed and 0 are eligible');
    const capped = refusal(input(bp, [anchor(1, { anchorExposureCap: 3 }), ...noAnchors.slice(1)], { exposure: new Map([[id(TAG.itemVersion, 1), 3]]) }));
    expect(capped.constraint).toBe('ITEM_COUNT');
    const cappedWithSpare = refusal(input(bp, [anchor(1, { anchorExposureCap: 3 }), ...noAnchors.slice(1), cand(7)], { exposure: new Map([[id(TAG.itemVersion, 1), 3]]) }));
    expect(cappedWithSpare.constraint).toBe('ANCHOR_FLOOR');
  });

  it('ANCHOR_FLOOR — anchors exist, but the section that must hold them cannot, because of their type', () => {
    // the one anchor is NUMERIC; the numeric slot is the only place it could go, and it is needed there — so it fits
    const pool = [anchor(1, { itemType: 'NUMERIC' }), cand(2), cand(3), cand(4), cand(5), cand(6)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 5, NUMERIC: 1 })]);
    const request = input(bp, pool);
    expect(violatedConstraints(request, expectValue(assembleForm(request)).sections)).toEqual([]);
  });

  it('the seven hard constraints are exactly the ones §6 names', () => {
    expect([...HARD_CONSTRAINTS]).toEqual(['ITEM_COUNT', 'TYPE_MIX', 'TOTAL_MARKS', 'PUBLISHED_ONLY', 'STIMULUS_SPLIT', 'NEAR_DUPLICATE', 'ANCHOR_FLOOR']);
  });

  it('refuses by naming, never by returning a form that is nearly right: every refusal carries a constraint from the list', () => {
    const refusals = [
      refusal(input(easyBlueprint(), easyPool().slice(0, 3))),
      refusal(input(blueprint([section(1, { NUMERIC: 6 })]), easyPool())),
    ];
    for (const error of refusals) expect(HARD_CONSTRAINTS).toContain(error.constraint);
  });
});

describe('backtracking', () => {
  // Section 1 wants a single-answer item; section 2 wants a numeric one, and
  // the only numeric item hangs on a passage. The best-ranked single-answer
  // item hangs on that same passage — so greedy takes it, and cannot then
  // place the numeric one. Only undoing the first choice works.
  const shared = id(TAG.stimulus, 1);
  const pool = () => [
    cand(1, { stimulusVersionId: shared, difficultyBand: 'advanced' }),
    cand(2, { difficultyBand: 'moderate' }),
    anchor(3, { itemType: 'NUMERIC', stimulusVersionId: shared }),
  ];
  const bp = () => blueprint([section(1, { SINGLE_CORRECT_MCQ: 1 }, { advanced: 1 }), section(2, { NUMERIC: 1 })]);

  it('undoes a greedy first choice to satisfy a later constraint, and succeeds', () => {
    const request = input(bp(), pool());
    const assembled = assembleForm(request);
    // the greedy first choice would have been item 1 (the band the section wanted)
    expect(chosenItems(assembled)).toEqual([id(TAG.item, 2), id(TAG.item, 3)]);
    expect(violatedConstraints(request, expectValue(assembled).sections)).toEqual([]);
  });

  it('greedy alone fails on the same input, so backtracking is what made it succeed', () => {
    const error = expectError(assembleForm(input(bp(), pool(), { backtracking: false })));
    expect(error.constraint).toBe('STIMULUS_SPLIT');
  });

  it('backtracks across more than one slot', () => {
    // three single-answer slots then a numeric one whose passage only the first-ranked single item shares
    const stim = id(TAG.stimulus, 2);
    const sharedConcept = id(0xc0, 777);
    const items = [
      cand(1, { stimulusVersionId: stim, difficultyBand: 'advanced', conceptIdentityIds: [sharedConcept] }),
      cand(2, { stimulusVersionId: stim, difficultyBand: 'advanced', conceptIdentityIds: [sharedConcept] }),
      cand(3, { difficultyBand: 'advanced', conceptIdentityIds: [sharedConcept] }),
      cand(4),
      cand(5),
      anchor(6, { itemType: 'NUMERIC', stimulusVersionId: stim }),
    ];
    const bp2 = blueprint([section(1, { SINGLE_CORRECT_MCQ: 3 }, { advanced: 3 }), section(2, { NUMERIC: 1 })]);
    const request = input(bp2, items);
    const assembled = assembleForm(request);
    expect(violatedConstraints(request, expectValue(assembled).sections)).toEqual([]);
    expect(chosenItems(assembled).slice(0, 3)).not.toContain(id(TAG.item, 1));
    expect(chosenItems(assembled).slice(0, 3)).not.toContain(id(TAG.item, 2));
  });

  it('gives up after its step budget, naming what kept blocking it', () => {
    // Infeasible only deep in the search, so the supply checks pass and the search must run.
    const shared2 = id(TAG.stimulus, 3);
    const items = [anchor(1, { stimulusVersionId: shared2 }), cand(2, { stimulusVersionId: shared2 }), cand(3, { stimulusVersionId: shared2 }), cand(4, { stimulusVersionId: shared2 })];
    const bp3 = blueprint([section(1, { SINGLE_CORRECT_MCQ: 1 }), section(2, { SINGLE_CORRECT_MCQ: 1 }), section(3, { SINGLE_CORRECT_MCQ: 1 }), section(4, { SINGLE_CORRECT_MCQ: 1 })]);
    const error = expectError(assembleForm(input(bp3, items, { maxSteps: 3 })));
    expect(error.code).toBe('ASSEMBLY_SEARCH_EXHAUSTED');
    expect(error.constraint).toBe('STIMULUS_SPLIT');
    expect(expectError(assembleForm(input(bp3, items))).code).toBe('ASSEMBLY_INFEASIBLE');
  });
});

describe('the step budget is honoured at every depth', () => {
  it('stops the whole search once a deeper level runs out of steps, not just that level', () => {
    // The matching items are near-duplicates of both numeric ones, so a form can never be built; the first section
    // has two candidates, so the parent still has one to try after the deeper level gives up.
    const pool = [anchor(1), anchor(2), cand(6), cand(3, { itemType: 'NUMERIC' }), cand(4, { itemType: 'NUMERIC' }), cand(5, { itemType: 'MATCHING' }), cand(7, { itemType: 'MATCHING' })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 1 }), section(2, { NUMERIC: 1, MATCHING: 1 })]);
    const v = (n: number) => id(TAG.itemVersion, n);
    const near = new Map([[v(5), new Set([v(3), v(4)])], [v(7), new Set([v(3), v(4)])]]);
    const limited = expectError(assembleForm(input(bp, pool, { nearDuplicates: near, maxSteps: 2 })));
    expect(limited.code).toBe('ASSEMBLY_SEARCH_EXHAUSTED');
    expect(HARD_CONSTRAINTS).toContain(limited.constraint);
    const unlimited = expectError(assembleForm(input(bp, pool, { nearDuplicates: near })));
    expect(unlimited.code).toBe('ASSEMBLY_INFEASIBLE');
    expect(unlimited.constraint).toBe('NEAR_DUPLICATE');
  });
});

describe('soft constraints change the choice and never the validity', () => {
  it('a form that misses its difficulty target is still a form, and says by how much it missed', () => {
    const pool = easyPool().map((c) => ({ ...c, difficultyBand: 'foundational' as const }));
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 3 }, { advanced: 3 }), section(2, { SINGLE_CORRECT_MCQ: 3 }, { advanced: 3 })], { difficultyTolerance: 2 });
    const request = input(bp, pool);
    const assembled = expectValue(assembleForm(request));
    expect(assembled.soft.difficultyShortfall).toBe(6);
    expect(assembled.soft.withinDifficultyTolerance).toBe(false);
    // and it is nonetheless a valid form
    expect(violatedConstraints(request, assembled.sections)).toEqual([]);
    expect(assembled.sections.flatMap((s) => s.slots)).toHaveLength(6);
  });

  it('is within tolerance exactly when the shortfall does not exceed it', () => {
    const pool = easyPool().map((c) => ({ ...c, difficultyBand: 'foundational' as const }));
    const make = (tolerance: number) => expectValue(assembleForm(input(blueprint([section(1, { SINGLE_CORRECT_MCQ: 6 }, { advanced: 6 })], { difficultyTolerance: tolerance }), pool)));
    expect(make(5).soft.withinDifficultyTolerance).toBe(false);
    expect(make(6).soft.withinDifficultyTolerance).toBe(true);
    const onTarget = expectValue(assembleForm(input(blueprint([section(1, { SINGLE_CORRECT_MCQ: 6 }, { foundational: 6 })]), pool)));
    expect(onTarget.soft.difficultyShortfall).toBe(0);
    expect(onTarget.soft.withinDifficultyTolerance).toBe(true);
  });

  it('difficulty: prefers the band the section still wants', () => {
    const pool = [anchor(1, { difficultyBand: 'advanced' }), cand(2, { difficultyBand: 'advanced' }), cand(3, { difficultyBand: 'moderate' }), cand(4, { difficultyBand: 'moderate' })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 }, { advanced: 1, moderate: 1 }), section(2, { SINGLE_CORRECT_MCQ: 2 }, { advanced: 1, moderate: 1 })], { difficultyTolerance: 0 });
    const assembled = expectValue(assembleForm(input(bp, pool)));
    expect(assembled.soft.difficultyShortfall).toBe(0);
  });

  it('concept coverage: prefers an item that adds a concept not yet covered', () => {
    const shared = id(0xc0, 900);
    const pool = [anchor(1, { conceptIdentityIds: [shared] }), cand(2, { conceptIdentityIds: [shared] }), cand(3, { conceptIdentityIds: [id(0xc0, 901)] })];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 })]);
    const picked = chosenItems(assembleForm(input(bp, pool)));
    expect(picked).toContain(id(TAG.item, 3));
    expect(expectValue(assembleForm(input(bp, pool))).soft.distinctConcepts).toBe(2);
  });

  it('exposure balance: prefers the least-exposed of otherwise equal items, and a different ledger gives a different choice', () => {
    const pool = [anchor(1), cand(2), cand(3)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 })]);
    const heavyOn2 = new Map([[id(TAG.itemVersion, 2), 9]]);
    const heavyOn3 = new Map([[id(TAG.itemVersion, 3), 9]]);
    const first = chosenItems(assembleForm(input(bp, pool, { exposure: heavyOn2 })));
    const second = chosenItems(assembleForm(input(bp, pool, { exposure: heavyOn3 })));
    expect(first).toContain(id(TAG.item, 3));
    expect(first).not.toContain(id(TAG.item, 2));
    expect(second).toContain(id(TAG.item, 2));
    expect(second).not.toContain(id(TAG.item, 3));
  });

  it('exposure is never a filter: a heavily exposed item is still used when nothing else will do', () => {
    const pool = [anchor(1), cand(2)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 2 })]);
    const assembled = expectValue(assembleForm(input(bp, pool, { exposure: new Map([[id(TAG.itemVersion, 2), 500]]) })));
    expect(assembled.sections[0]!.slots).toHaveLength(2);
    expect(assembled.soft.meanExposure).toBe(250);
  });

  it('an anchor under its cap is used and one at its cap is not', () => {
    const pool = [anchor(1, { anchorExposureCap: 5 }), anchor(2, { anchorExposureCap: 5 }), cand(3), cand(4), cand(5), cand(6)];
    const bp = blueprint([section(1, { SINGLE_CORRECT_MCQ: 5 })]);
    const picked = chosenItems(assembleForm(input(bp, pool, { exposure: new Map([[id(TAG.itemVersion, 1), 5], [id(TAG.itemVersion, 2), 4]]) })));
    expect(picked).toContain(id(TAG.item, 2));
    expect(picked).not.toContain(id(TAG.item, 1));
  });

  it('an anchor with no cap recorded is never capped out', () => {
    const pool = [anchor(1, { anchorExposureCap: null }), cand(2), cand(3), cand(4), cand(5), cand(6)];
    const picked = chosenItems(assembleForm(input(blueprint([section(1, { SINGLE_CORRECT_MCQ: 6 })]), pool, { exposure: new Map([[id(TAG.itemVersion, 1), 1000]]) })));
    expect(picked).toContain(id(TAG.item, 1));
  });
});

describe('determinism', () => {
  it('gives the same form whatever order the candidates arrive in', () => {
    const request = input(easyBlueprint(), easyPool());
    const expected = JSON.stringify(expectValue(assembleForm(request)));
    for (let seed = 1; seed <= 25; seed += 1) {
      const shuffledRequest = { ...request, candidates: shuffled(request.candidates, seeded(seed)) };
      expect(JSON.stringify(expectValue(assembleForm(shuffledRequest)))).toBe(expected);
    }
  });

  it('over random pools: every form it returns satisfies every hard constraint by the independent check, and is order-independent', () => {
    let successes = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = seeded(seed);
      const types: BlueprintItemType[] = ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC'];
      const bands: BlueprintDifficultyBand[] = ['foundational', 'moderate', 'challenging', 'advanced'];
      const pool = Array.from({ length: 24 }, (_, i) =>
        cand(i + 1, {
          itemType: types[Math.floor(random() * 4)]!,
          difficultyBand: bands[Math.floor(random() * 4)]!,
          stimulusVersionId: random() < 0.3 ? id(TAG.stimulus, 1 + Math.floor(random() * 3)) : null,
          isAnchor: random() < 0.3,
          anchorExposureCap: 5,
          isPublished: random() < 0.9,
        }),
      );
      const near = new Map<string, Set<string>>();
      for (let k = 0; k < 4; k += 1) {
        const a = pool[Math.floor(random() * pool.length)]!.itemVersionId;
        const b = pool[Math.floor(random() * pool.length)]!.itemVersionId;
        near.set(a, (near.get(a) ?? new Set()).add(b));
      }
      const bp = blueprint([
        section(1, { SINGLE_CORRECT_MCQ: 2, NUMERIC: 1 }),
        section(2, { MULTIPLE_CORRECT_MCQ: 1, MATCHING: 1, SINGLE_CORRECT_MCQ: 1 }),
      ]);
      const request = input(bp, pool, { nearDuplicates: near, exposure: new Map(pool.map((c) => [c.itemVersionId, Math.floor(random() * 4)])) });
      const result = assembleForm(request);
      if (result.ok) {
        successes += 1;
        expect(violatedConstraints(request, result.value.sections), `seed ${seed}`).toEqual([]);
        expect(JSON.stringify(assembleForm({ ...request, candidates: shuffled(pool, random) }))).toBe(JSON.stringify(result));
      } else {
        expect(HARD_CONSTRAINTS).toContain(result.error.constraint);
      }
    }
    // not vacuous: a good share of the random cases really do assemble
    expect(successes).toBeGreaterThan(30);
  });
});

describe('the independent checker can see each hard constraint broken (it is shown red)', () => {
  const base = () => {
    const request = input(easyBlueprint(), easyPool());
    return { request, form: expectValue(assembleForm(request)).sections };
  };
  const withSlots = (form: ReturnType<typeof base>['form'], edit: (slots: { [k: string]: unknown }[]) => void) => {
    const copy = form.map((s) => ({ ...s, slots: s.slots.map((slot) => ({ ...slot })) }));
    edit(copy.flatMap((s) => s.slots));
    return copy as unknown as typeof form;
  };
  const broken = (constraint: HardConstraint, request: AssemblyInput, form: ReturnType<typeof base>['form']) =>
    expect(violatedConstraints(request, form)).toContain(constraint);

  it('ITEM_COUNT: a slot dropped, a section missing, an item used twice', () => {
    const { request, form } = base();
    broken('ITEM_COUNT', request, [{ ...form[0]!, slots: form[0]!.slots.slice(1) }, form[1]!]);
    broken('ITEM_COUNT', request, [form[0]!]);
    broken('ITEM_COUNT', request, withSlots(form, (slots) => { slots[1]!['itemId'] = slots[0]!['itemId']; }));
  });

  it('TYPE_MIX: an item of the wrong type', () => {
    const request = input(easyBlueprint(), [...easyPool().slice(0, 6).map((c, i) => (i === 1 ? { ...c, itemType: 'NUMERIC' as const } : c))]);
    const form = expectValue(assembleForm(input(easyBlueprint(), easyPool()))).sections;
    expect(violatedConstraints(request, form)).toContain('TYPE_MIX');
  });

  it('TOTAL_MARKS: a slot worth other than the blueprint says', () => {
    const { request, form } = base();
    broken('TOTAL_MARKS', request, withSlots(form, (slots) => { slots[0]!['marksAvailable'] = 5; }));
  });

  it('PUBLISHED_ONLY: an unpublished item, and one the pool does not know', () => {
    const { request, form } = base();
    broken('PUBLISHED_ONLY', { ...request, candidates: request.candidates.map((c) => ({ ...c, isPublished: false })) }, form);
    broken('PUBLISHED_ONLY', request, withSlots(form, (slots) => { slots[0]!['itemVersionId'] = id(TAG.itemVersion, 999); }));
  });

  it('STIMULUS_SPLIT: one passage in two sections', () => {
    const { request, form } = base();
    broken('STIMULUS_SPLIT', request, withSlots(form, (slots) => { slots[0]!['stimulusVersionId'] = 'S'; slots[5]!['stimulusVersionId'] = 'S'; }));
  });

  it('NEAR_DUPLICATE: two chosen versions the map calls duplicates', () => {
    const { request, form } = base();
    const [a, b] = form.flatMap((s) => s.slots).map((slot) => slot.itemVersionId);
    broken('NEAR_DUPLICATE', { ...request, nearDuplicates: new Map([[a!, new Set([b!])]]) }, form);
  });

  it('ANCHOR_FLOOR: no anchor slots', () => {
    const { request, form } = base();
    broken('ANCHOR_FLOOR', request, withSlots(form, (slots) => { for (const slot of slots) slot['isAnchor'] = false; }));
  });

  it('is empty for a valid form, and a planted assembler that ignores the stimulus rule is caught by it', () => {
    const { request, form } = base();
    expect(violatedConstraints(request, form)).toEqual([]);
    // a "planted" assembler: no search, just take the first N and ignore every rule but the count
    const shared = id(TAG.stimulus, 7);
    const candidates = [anchor(1, { stimulusVersionId: shared }), cand(2, { stimulusVersionId: shared }), cand(3), cand(4), cand(5), cand(6)];
    const naive = [
      { ordinal: 1, sectionSpecRef: 's1', slots: candidates.slice(0, 3).map((c, i) => ({ slotId: slotId(1, i), ordinal: i + 1, itemId: c.itemId, itemVersionId: c.itemVersionId, stimulusVersionId: c.stimulusVersionId, marksAvailable: 4, isAnchor: c.isAnchor })) },
      { ordinal: 2, sectionSpecRef: 's2', slots: candidates.slice(3).map((c, i) => ({ slotId: slotId(2, i), ordinal: i + 4, itemId: c.itemId, itemVersionId: c.itemVersionId, stimulusVersionId: c.stimulusVersionId, marksAvailable: 4, isAnchor: c.isAnchor })) },
    ];
    expect(violatedConstraints(input(easyBlueprint(), candidates), naive)).toEqual([]);
    const split = [naive[0]!, { ...naive[1]!, slots: [{ ...naive[1]!.slots[0]!, stimulusVersionId: shared }, ...naive[1]!.slots.slice(1)] }];
    expect(violatedConstraints(input(easyBlueprint(), candidates), split)).toContain('STIMULUS_SPLIT');
  });
});

describe('the anchor floor in whole numbers', () => {
  it('needs the fewest anchors that reach 15%', () => {
    expect([1, 6, 7, 20, 21, 100].map(requiredAnchors)).toEqual([1, 1, 2, 3, 4, 15]);
  });
});
