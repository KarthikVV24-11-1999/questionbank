import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, aDraftForm, aPublishedForm, formProps, formSlots, id } from '../../../testing/assessment-fixtures.js';
import * as formModule from './form.js';
import {
  FORM_STATES,
  FORM_TYPES,
  MINIMUM_ANCHOR_PERCENT,
  anchorPercent,
  createAttemptFromForm,
  createForm,
  pinSlots,
  publishForm,
  restoreForm,
  slotsOf,
  substituteSlot,
  type CreateFormProps,
  type Form,
  type FormSlot,
  type FormSnapshot,
} from './form.js';

const NOW = '2026-10-21T07:00:00.000Z';

function withAnchors(anchorFlags: readonly boolean[]): Form {
  const slots = formSlots().map((slot, i) => ({ ...slot, isAnchor: anchorFlags[i] ?? false }));
  return aDraftForm({
    sections: [
      { ordinal: 1, sectionSpecRef: 'a', slots: slots.slice(0, 3) },
      { ordinal: 2, sectionSpecRef: 'b', slots: slots.slice(3) },
    ],
  });
}

describe('creating a form', () => {
  it('is a draft, frozen all the way down, with sections and slots in order', () => {
    const form = aDraftForm({
      sections: [
        { ordinal: 2, sectionSpecRef: 'physics-b', slots: formSlots().slice(3).reverse() },
        { ordinal: 1, sectionSpecRef: 'physics-a', slots: formSlots().slice(0, 3) },
      ],
    });
    expect(form.state).toBe('draft');
    expect(form.publishedAt).toBeNull();
    expect(form.sections.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(form.sections[1]?.slots.map((s) => s.ordinal)).toEqual([4, 5, 6]);
    expect(Object.isFrozen(form)).toBe(true);
    expect(Object.isFrozen(form.sections)).toBe(true);
    expect(Object.isFrozen(form.sections[0])).toBe(true);
    expect(Object.isFrozen(form.sections[0]?.slots[0])).toBe(true);
    expect(Object.isFrozen(form.blueprintConformance)).toBe(true);
  });

  it('pins the item version of every slot, which is not the item', () => {
    for (const slot of slotsOf(aDraftForm())) {
      expect(slot.itemVersionId).not.toBe(slot.itemId);
    }
  });

  it('names the vocabularies it accepts', () => {
    expect([...FORM_TYPES]).toEqual(['mock', 'diagnostic']);
    expect([...FORM_STATES]).toEqual(['draft', 'published']);
  });

  const slot = (overrides: Partial<FormSlot>): FormSlot => ({ ...formSlots()[0]!, ...overrides });
  const withSlot = (overrides: Partial<FormSlot>): Partial<CreateFormProps> => ({
    sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [slot(overrides)] }],
  });

  const REFUSALS: readonly (readonly [string, Partial<CreateFormProps>, string])[] = [
    ['a bad form id', { formId: 'nope' }, 'FORM_ID_INVALID'],
    ['a bad profile version', { examProfileVersionId: 'nope' }, 'FORM_PROFILE_INVALID'],
    ['an unknown form type', { formType: 'practice' as 'mock' }, 'FORM_TYPE_INVALID'],
    ['conformance that is not an object', { blueprintConformance: [] as unknown as Record<string, unknown> }, 'FORM_CONFORMANCE_INVALID'],
    ['conformance with no satisfied flag', { blueprintConformance: {} }, 'FORM_CONFORMANCE_INVALID'],
    ['no sections', { sections: [] }, 'FORM_SECTIONS_INVALID'],
    ['a section with no slots', { sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [] }] }, 'FORM_SECTIONS_INVALID'],
    ['a section with no spec reference', { sections: [{ ordinal: 1, sectionSpecRef: ' ', slots: formSlots().slice(0, 1) }] }, 'FORM_SECTIONS_INVALID'],
    ['a negative section ordinal', { sections: [{ ordinal: -1, sectionSpecRef: 'a', slots: formSlots().slice(0, 1) }] }, 'FORM_SECTIONS_INVALID'],
    [
      'a repeated section ordinal',
      {
        sections: [
          { ordinal: 1, sectionSpecRef: 'a', slots: formSlots().slice(0, 1) },
          { ordinal: 1, sectionSpecRef: 'b', slots: formSlots().slice(1, 2) },
        ],
      },
      'FORM_SECTIONS_INVALID',
    ],
    ['a slot with a bad id', withSlot({ slotId: 'nope' }), 'FORM_SLOT_INVALID'],
    ['a slot with a bad item', withSlot({ itemId: 'nope' }), 'FORM_SLOT_INVALID'],
    ['a slot with no item version', withSlot({ itemVersionId: 'nope' }), 'FORM_SLOT_INVALID'],
    ['a slot with a bad stimulus', withSlot({ stimulusVersionId: 'nope' }), 'FORM_SLOT_INVALID'],
    ['a negative slot ordinal', withSlot({ ordinal: -1 }), 'FORM_SLOT_INVALID'],
    ['zero marks', withSlot({ marksAvailable: 0 }), 'FORM_SLOT_INVALID'],
    ['no anchor flag (§12)', withSlot({ isAnchor: undefined as unknown as boolean }), 'FORM_SLOT_INVALID'],
    ['a null anchor flag (§12)', withSlot({ isAnchor: null as unknown as boolean }), 'FORM_SLOT_INVALID'],
    ['a repeated slot id', { sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [slot({}), slot({ ordinal: 9, itemId: id(TAG.item, 9) })] }] }, 'FORM_SLOT_INVALID'],
    ['a repeated slot ordinal', { sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [slot({}), slot({ slotId: id(TAG.slot, 9), itemId: id(TAG.item, 9) })] }] }, 'FORM_SLOT_INVALID'],
    ['the same item twice', { sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [slot({}), slot({ slotId: id(TAG.slot, 9), ordinal: 9 })] }] }, 'FORM_SLOT_INVALID'],
  ];

  it.each(REFUSALS)('refuses %s', (_name, overrides, code) => {
    const error = expectError(createForm(formProps(overrides)));
    expect(error.code).toBe(code);
    expect(error.kind).toBe('Validation');
  });

  it('accepts a slot with no stimulus', () => {
    expect(slotsOf(aDraftForm(withSlot({ stimulusVersionId: null })))[0]?.stimulusVersionId).toBeNull();
  });
});

describe('F50 — a published form is at least 15% anchor items', () => {
  it('names the floor', () => {
    expect(MINIMUM_ANCHOR_PERCENT).toBe(15);
  });

  it('publishes at the floor and above: 1 of 6 is 16%', () => {
    expect(anchorPercent(withAnchors([true]))).toBe(16);
    expect(publishForm(withAnchors([true]), NOW).ok).toBe(true);
    expect(publishForm(withAnchors([true, true, true, true, true, true]), NOW).ok).toBe(true);
  });

  it('refuses a form with no anchors at all', () => {
    const error = expectError(publishForm(withAnchors([]), NOW));
    expect(error.code).toBe('FORM_ANCHOR_SHARE_TOO_LOW');
    expect(error.kind).toBe('PreconditionFailed');
    expect(error.message).toContain('0%');
  });

  it('refuses just under the floor and accepts exactly on it', () => {
    // 20 slots: 3 anchors is exactly 15%, 2 is 10%.
    const make = (anchors: number): Form => {
      const slots: FormSlot[] = Array.from({ length: 20 }, (_, i) => ({
        slotId: id(TAG.slot, i + 1),
        ordinal: i + 1,
        itemId: id(TAG.item, i + 1),
        itemVersionId: id(TAG.itemVersion, i + 1),
        stimulusVersionId: null,
        marksAvailable: 4,
        isAnchor: i < anchors,
      }));
      return aDraftForm({ sections: [{ ordinal: 1, sectionSpecRef: 'a', slots }] });
    };
    expect(publishForm(make(3), NOW).ok).toBe(true);
    expect(expectError(publishForm(make(2), NOW)).code).toBe('FORM_ANCHOR_SHARE_TOO_LOW');
    expect(anchorPercent(make(3))).toBe(15);
    expect(anchorPercent(make(2))).toBe(10);
  });

  it('is checked on the same arithmetic the percent is reported with: no rounding up into a pass', () => {
    // 7 slots, 1 anchor = 14.28…%: below the floor even though it rounds to 14, and 15 would round differently
    const slots: FormSlot[] = Array.from({ length: 7 }, (_, i) => ({ ...formSlots()[0]!, slotId: id(TAG.slot, i + 1), ordinal: i + 1, itemId: id(TAG.item, i + 1), isAnchor: i === 0 }));
    const form = aDraftForm({ sections: [{ ordinal: 1, sectionSpecRef: 'a', slots }] });
    expect(anchorPercent(form)).toBe(14);
    expect(expectError(publishForm(form, NOW)).code).toBe('FORM_ANCHOR_SHARE_TOO_LOW');
  });
});

describe('publishing', () => {
  it('freezes a conforming draft and stamps when', () => {
    const published = expectValue(publishForm(aDraftForm(), NOW));
    expect(published.state).toBe('published');
    expect(published.publishedAt).toBe(NOW);
    expect(Object.isFrozen(published)).toBe(true);
  });

  it('refuses a form that does not satisfy its blueprint', () => {
    const error = expectError(publishForm(aDraftForm({ blueprintConformance: { satisfied: false } }), NOW));
    expect(error.code).toBe('FORM_NOT_CONFORMING');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('refuses a malformed now, and publishing twice', () => {
    expect(expectError(publishForm(aDraftForm(), 'today')).code).toBe('FORM_NOW_INVALID');
    expect(expectError(publishForm(aPublishedForm(), NOW)).code).toBe('FORM_IS_PUBLISHED');
  });

  it('does not change the draft it was given', () => {
    const draft = aDraftForm();
    publishForm(draft, NOW);
    expect(draft.state).toBe('draft');
    expect(draft.publishedAt).toBeNull();
  });
});

describe('D-006 — immutable from publication, not from the first attempt', () => {
  const REPLACEMENT = { itemId: id(TAG.item, 50), itemVersionId: id(TAG.itemVersion, 50), stimulusVersionId: null, isAnchor: true };

  it('substitutes an item in a draft, keeping the slot\'s place and marks', () => {
    const draft = aDraftForm();
    const target = slotsOf(draft)[2]!;
    const changed = expectValue(substituteSlot(draft, target.slotId, REPLACEMENT));
    const after = slotsOf(changed)[2]!;
    expect(after.slotId).toBe(target.slotId);
    expect(after.ordinal).toBe(target.ordinal);
    expect(after.marksAvailable).toBe(target.marksAvailable);
    expect([after.itemId, after.itemVersionId, after.isAnchor]).toEqual([REPLACEMENT.itemId, REPLACEMENT.itemVersionId, true]);
    expect(slotsOf(draft)[2]?.itemId).toBe(target.itemId);
  });

  it('refuses the same substitution once published, with no attempt in sight', () => {
    const published = aPublishedForm();
    const error = expectError(substituteSlot(published, slotsOf(published)[2]!.slotId, REPLACEMENT));
    expect(error.code).toBe('FORM_IS_PUBLISHED');
    expect(error.kind).toBe('RuleViolation');
  });

  it('refuses a slot the form does not have', () => {
    expect(expectError(substituteSlot(aDraftForm(), id(TAG.slot, 99), REPLACEMENT)).code).toBe('FORM_SLOT_NOT_FOUND');
  });

  it('refuses a substitution that would break the form: the same item twice', () => {
    const draft = aDraftForm();
    const [first, second] = slotsOf(draft);
    const error = expectError(substituteSlot(draft, first!.slotId, { ...REPLACEMENT, itemId: second!.itemId }));
    expect(error.code).toBe('FORM_SLOT_INVALID');
  });

  // The set, not the loop: every export of the module is classified here, so a
  // new operation that changes composition cannot arrive without being asked
  // whether it refuses a published form.
  const CLASSIFIED = {
    // changes composition — must refuse a published form
    substituteSlot: 'mutator',
    // moves the lifecycle — draft → published only
    publishForm: 'lifecycle',
    // builders and constants
    createForm: 'builder',
    createAttemptFromForm: 'builder',
    restoreForm: 'builder',
    FORM_TYPES: 'value',
    FORM_STATES: 'value',
    MINIMUM_ANCHOR_PERCENT: 'value',
    // reads
    slotsOf: 'read',
    anchorPercent: 'read',
    pinSlots: 'read',
  } as const;

  it('classifies every export of the form module', () => {
    expect(Object.keys(formModule).sort()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('every composition-changing operation refuses a published form', () => {
    const published = aPublishedForm();
    const mutators = Object.entries(CLASSIFIED).filter(([, kind]) => kind === 'mutator').map(([name]) => name);
    expect(mutators).toEqual(['substituteSlot']);
    expect(expectError(substituteSlot(published, slotsOf(published)[0]!.slotId, REPLACEMENT)).code).toBe('FORM_IS_PUBLISHED');
  });

  it('the object itself cannot be edited in place', () => {
    const published = aPublishedForm();
    expect(() => {
      (published as { state: string }).state = 'draft';
    }).toThrow(TypeError);
    expect(() => {
      (slotsOf(published)[0] as { itemVersionId: string }).itemVersionId = 'x';
    }).toThrow(TypeError);
  });
});

describe('an attempt is created from a published form', () => {
  const attemptProps = {
    attemptId: id(TAG.attempt),
    studentId: id(TAG.student),
    markingRuleSetHash: 'b'.repeat(64),
    taxonomyVersionId: id(TAG.taxonomy),
    deliveryPolicy: { timing: 'strict' },
    sessionId: id(TAG.session),
    shiftId: 'shift-1',
    durationMs: 10_800_000,
    windowClosesAt: '2026-10-22T12:00:00.000Z',
    createdAt: '2026-10-22T08:00:00.000Z',
  };

  it('copies the form\'s identity, profile, mode and every slot\'s pinned version', () => {
    const form = aPublishedForm();
    const attempt = expectValue(createAttemptFromForm(form, attemptProps));
    expect(attempt.formId).toBe(form.formId);
    expect(attempt.examProfileVersionId).toBe(form.examProfileVersionId);
    expect(attempt.mode).toBe('mock');
    expect(attempt.slots.map((s) => s.itemVersionId)).toEqual(slotsOf(form).map((s) => s.itemVersionId));
    expect(attempt.slots).toEqual(pinSlots(form));
  });

  it('a diagnostic form makes a diagnostic attempt', () => {
    const attempt = expectValue(createAttemptFromForm(aPublishedForm({ formType: 'diagnostic' }), attemptProps));
    expect(attempt.mode).toBe('diagnostic');
  });

  it('refuses a draft', () => {
    const error = expectError(createAttemptFromForm(aDraftForm(), attemptProps));
    expect(error.code).toBe('FORM_NOT_PUBLISHED');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('passes the attempt\'s own validation through', () => {
    expect(expectError(createAttemptFromForm(aPublishedForm(), { ...attemptProps, shiftId: '' })).code).toBe('ATTEMPT_SHIFT_INVALID');
  });
});

describe('restoring a form from storage', () => {
  const snapshot = (overrides: Partial<FormSnapshot> = {}): FormSnapshot => ({ ...formProps(), state: 'draft', publishedAt: null, ...overrides });

  it('restores a draft and a published form with their state and publication time', () => {
    expect(expectValue(restoreForm(snapshot())).state).toBe('draft');
    const published = expectValue(restoreForm(snapshot({ state: 'published', publishedAt: NOW })));
    expect(published.state).toBe('published');
    expect(published.publishedAt).toBe(NOW);
    expect(Object.isFrozen(published)).toBe(true);
  });

  it('does not re-run the publication rules: a form published under an earlier rule is still history', () => {
    const noAnchors = formSlots().map((slot) => ({ ...slot, isAnchor: false }));
    const sections = [{ ordinal: 1, sectionSpecRef: 'a', slots: noAnchors }];
    const restored = expectValue(restoreForm(snapshot({ state: 'published', publishedAt: NOW, sections, blueprintConformance: { satisfied: false } })));
    expect(restored.state).toBe('published');
  });

  it('refuses a state that disagrees with the publication time, and a malformed one', () => {
    expect(expectError(restoreForm(snapshot({ state: 'published' }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ publishedAt: NOW }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'published', publishedAt: 'then' }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'embargoed' as 'draft' }))).code).toBe('FORM_STORED_STATE_INVALID');
  });

  it('refuses a snapshot the creation rules refuse, with their own code', () => {
    expect(expectError(restoreForm(snapshot({ formId: 'nope' }))).code).toBe('FORM_ID_INVALID');
  });
});
