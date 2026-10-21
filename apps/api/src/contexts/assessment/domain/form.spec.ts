import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { SESSION_REF, TAG, WINDOW, WITHIN_WINDOW, aClosedForm, aDraftForm, aPublishedForm, aScheduledForm, anActiveForm, formProps, formSlots, id, poolOf } from '../../../testing/assessment-fixtures.js';
import * as formModule from './form.js';
import {
  FORM_STATES,
  FORM_TYPES,
  MINIMUM_ANCHOR_PERCENT,
  anchorPercent,
  closeForm,
  createAttemptFromForm,
  createForm,
  openForm,
  scheduleForm,
  meetsAnchorFloor,
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
    expect([...FORM_STATES]).toEqual(['draft', 'published', 'embargoed', 'active', 'closed']);
  });

  const slot = (overrides: Partial<FormSlot>): FormSlot => ({ ...formSlots()[0]!, ...overrides });
  const withSlot = (overrides: Partial<FormSlot>): Partial<CreateFormProps> => ({
    sections: [{ ordinal: 1, sectionSpecRef: 'a', slots: [slot(overrides)] }],
  });

  const REFUSALS: readonly (readonly [string, Partial<CreateFormProps>, string])[] = [
    ['a bad form id', { formId: 'nope' }, 'FORM_ID_INVALID'],
    ['a bad profile version', { examProfileVersionId: 'nope' }, 'FORM_PROFILE_INVALID'],
    ['an unknown form type', { formType: 'practice' as 'mock' }, 'FORM_TYPE_INVALID'],
    ['no session to publish for (§12)', { sessionRefs: [] }, 'FORM_SESSIONS_INVALID'],
    ['a blank session', { sessionRefs: [' '] }, 'FORM_SESSIONS_INVALID'],
    ['a session key with stray whitespace', { sessionRefs: [' s '] }, 'FORM_SESSIONS_INVALID'],
    ['the unassigned placeholder', { sessionRefs: ['unassigned:abc'] }, 'FORM_SESSIONS_INVALID'],
    ['a repeated session', { sessionRefs: ['s', 's'] }, 'FORM_SESSIONS_INVALID'],
    ['missing sessions (§12)', { sessionRefs: undefined as unknown as string[] }, 'FORM_SESSIONS_INVALID'],
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
    expect(publishForm(withAnchors([true]), NOW, poolOf(withAnchors([true]))).ok).toBe(true);
    expect(publishForm(withAnchors([true, true, true, true, true, true]), NOW, poolOf(withAnchors([true, true, true, true, true, true]))).ok).toBe(true);
  });

  it('refuses a form with no anchors at all', () => {
    const error = expectError(publishForm(withAnchors([]), NOW, new Set()));
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
    expect(publishForm(make(3), NOW, poolOf(make(3))).ok).toBe(true);
    expect(expectError(publishForm(make(2), NOW, poolOf(make(2)))).code).toBe('FORM_ANCHOR_SHARE_TOO_LOW');
    expect(anchorPercent(make(3))).toBe(15);
    expect(anchorPercent(make(2))).toBe(10);
  });

  it('is checked on the same arithmetic the percent is reported with: no rounding up into a pass', () => {
    // 7 slots, 1 anchor = 14.28…%: below the floor even though it rounds to 14, and 15 would round differently
    const slots: FormSlot[] = Array.from({ length: 7 }, (_, i) => ({ ...formSlots()[0]!, slotId: id(TAG.slot, i + 1), ordinal: i + 1, itemId: id(TAG.item, i + 1), itemVersionId: id(TAG.itemVersion, i + 1), isAnchor: i === 0 }));
    const form = aDraftForm({ sections: [{ ordinal: 1, sectionSpecRef: 'a', slots }] });
    expect(anchorPercent(form)).toBe(14);
    expect(expectError(publishForm(form, NOW, poolOf(form))).code).toBe('FORM_ANCHOR_SHARE_TOO_LOW');
  });
});

describe('F50 — the anchors are counted against the pool, not against the form\'s own say-so', () => {
  it('refuses a slot flagged an anchor whose item version is not in the pool', () => {
    const form = withAnchors([true]);
    const error = expectError(publishForm(form, NOW, new Set()));
    expect(error.code).toBe('FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL');
    expect(error.kind).toBe('PreconditionFailed');
    expect(error.message).toContain('flagged an anchor but its item version is not in the anchor pool');
  });

  it('refuses a pool member left unflagged: it would be miscounted in every later equating', () => {
    const form = withAnchors([true]);
    const error = expectError(publishForm(form, NOW, new Set([...poolOf(form), slotsOf(form)[3]!.itemVersionId])));
    expect(error.code).toBe('FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL');
    expect(error.message).toContain('not flagged an anchor but its item version is in the anchor pool');
  });

  it('a form full of flagged non-members cannot pass the floor by flagging itself', () => {
    const allFlagged = withAnchors([true, true, true, true, true, true]);
    expect(expectError(publishForm(allFlagged, NOW, new Set())).code).toBe('FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL');
  });

  it('meetsAnchorFloor is exact in whole numbers', () => {
    expect([meetsAnchorFloor(3, 20), meetsAnchorFloor(2, 20), meetsAnchorFloor(1, 7), meetsAnchorFloor(1, 6), meetsAnchorFloor(0, 0)]).toEqual([
      true, false, false, true, false,
    ]);
  });
});

describe('publishing', () => {
  it('freezes a conforming draft and stamps when', () => {
    const published = expectValue(publishForm(aDraftForm(), NOW, poolOf(aDraftForm())));
    expect(published.state).toBe('published');
    expect(published.publishedAt).toBe(NOW);
    expect(Object.isFrozen(published)).toBe(true);
  });

  it('refuses a form that does not satisfy its blueprint', () => {
    const error = expectError(publishForm(aDraftForm({ blueprintConformance: { satisfied: false } }), NOW, poolOf(aDraftForm())));
    expect(error.code).toBe('FORM_NOT_CONFORMING');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('refuses a malformed now, and publishing twice', () => {
    expect(expectError(publishForm(aDraftForm(), 'today', new Set())).code).toBe('FORM_NOW_INVALID');
    expect(expectError(publishForm(aPublishedForm(), NOW, new Set())).code).toBe('FORM_IS_PUBLISHED');
  });

  it('does not change the draft it was given', () => {
    const draft = aDraftForm();
    publishForm(draft, NOW, poolOf(draft));
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
    // moves the lifecycle past publication — the form's composition does not move
    scheduleForm: 'lifecycle',
    openForm: 'lifecycle',
    closeForm: 'lifecycle',
    FORM_TRIGGERS: 'value',
    FORM_TYPES: 'value',
    FORM_STATES: 'value',
    MINIMUM_ANCHOR_PERCENT: 'value',
    // reads
    slotsOf: 'read',
    anchorPercent: 'read',
    meetsAnchorFloor: 'read',
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

describe('an attempt is created from an open form', () => {
  const attemptProps = {
    attemptId: id(TAG.attempt),
    studentId: id(TAG.student),
    markingRuleSetHash: 'b'.repeat(64),
    taxonomyVersionId: id(TAG.taxonomy),
    deliveryPolicy: { timing: 'strict' },
    sessionRef: SESSION_REF,
    shiftId: 'shift-1',
    durationMs: 10_800_000,
    createdAt: '2026-10-21T08:00:00.000Z',
  };

  it('copies the form\'s identity, profile, mode, every slot\'s pinned version and its window', () => {
    const form = anActiveForm();
    const attempt = expectValue(createAttemptFromForm(form, attemptProps, WITHIN_WINDOW));
    expect(attempt.formId).toBe(form.formId);
    expect(attempt.examProfileVersionId).toBe(form.examProfileVersionId);
    expect(attempt.mode).toBe('mock');
    expect(attempt.slots.map((s) => s.itemVersionId)).toEqual(slotsOf(form).map((s) => s.itemVersionId));
    expect(attempt.slots).toEqual(pinSlots(form));
    expect(attempt.windowClosesAt).toBe(WINDOW.closesAt);
  });

  it('takes the window from the form: there is no way to hand it one', () => {
    const smuggled = { ...attemptProps, windowClosesAt: '2099-01-01T00:00:00.000Z' } as never;
    expect(expectValue(createAttemptFromForm(anActiveForm(), smuggled, WITHIN_WINDOW)).windowClosesAt).toBe(WINDOW.closesAt);
  });

  it('a diagnostic form makes a diagnostic attempt', () => {
    expect(expectValue(createAttemptFromForm(anActiveForm({ formType: 'diagnostic' }), attemptProps, WITHIN_WINDOW)).mode).toBe('diagnostic');
  });

  it('refuses every state but active, naming it', () => {
    for (const form of [aDraftForm(), aPublishedForm(), aScheduledForm(), aClosedForm()]) {
      const error = expectError(createAttemptFromForm(form, attemptProps, WITHIN_WINDOW));
      expect(error.code, form.state).toBe('FORM_NOT_OPEN_FOR_ATTEMPTS');
      expect(error.kind).toBe('PreconditionFailed');
      expect(error.message).toContain(form.state);
    }
  });

  it('refuses an active form outside its window, whichever side, even though its state says active', () => {
    const form = anActiveForm();
    expect(expectError(createAttemptFromForm(form, attemptProps, '2026-10-21T07:59:59.999Z')).code).toBe('FORM_WINDOW_NOT_YET_OPEN');
    expect(expectError(createAttemptFromForm(form, attemptProps, WINDOW.closesAt)).code).toBe('FORM_WINDOW_CLOSED');
    expect(createAttemptFromForm(form, attemptProps, WINDOW.opensAt).ok).toBe(true);
    expect(createAttemptFromForm(form, attemptProps, '2026-10-21T11:59:59.999Z').ok).toBe(true);
  });

  it('refuses a malformed now', () => {
    expect(expectError(createAttemptFromForm(anActiveForm(), attemptProps, 'noon')).code).toBe('FORM_NOW_INVALID');
  });

  it('copies the session from a sitting the form was published for, and refuses one it was not (ADR-0032)', () => {
    const form = anActiveForm({ sessionRefs: ['2026-01-27/shift-1', '2026-01-27/shift-2'] });
    expect(form.sessionRefs).toEqual(['2026-01-27/shift-1', '2026-01-27/shift-2']);
    for (const sessionRef of form.sessionRefs) {
      expect(expectValue(createAttemptFromForm(form, { ...attemptProps, sessionRef }, WITHIN_WINDOW)).sessionRef).toBe(sessionRef);
    }
    const error = expectError(createAttemptFromForm(form, { ...attemptProps, sessionRef: '2026-01-28/shift-1' }, WITHIN_WINDOW));
    expect(error.code).toBe('FORM_SESSION_NOT_PUBLISHED_FOR');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('keeps a form\'s sessions in a fixed order, so the same sittings are the same form', () => {
    expect(aDraftForm({ sessionRefs: ['b', 'a'] }).sessionRefs).toEqual(['a', 'b']);
  });

  it('passes the attempt\'s own validation through', () => {
    expect(expectError(createAttemptFromForm(anActiveForm(), { ...attemptProps, shiftId: '' }, WITHIN_WINDOW)).code).toBe('ATTEMPT_SHIFT_INVALID');
  });
});

describe('scheduling, opening and closing', () => {
  const NOW_SCHEDULING = '2026-10-21T07:30:00.000Z';

  it('schedules a published form: it gains its window and the embargoed state, and is otherwise untouched', () => {
    const published = aPublishedForm();
    const scheduled = expectValue(scheduleForm(published, WINDOW, NOW_SCHEDULING));
    expect(scheduled.state).toBe('embargoed');
    expect(scheduled.scheduleWindow).toEqual(WINDOW);
    expect(scheduled.publishedAt).toBe(published.publishedAt);
    expect(slotsOf(scheduled)).toEqual(slotsOf(published));
    expect(Object.isFrozen(scheduled)).toBe(true);
    expect(Object.isFrozen(scheduled.scheduleWindow)).toBe(true);
    expect(published.scheduleWindow).toBeNull();
  });

  it('refuses a window that ends before it starts, one already over, and malformed ones', () => {
    const published = aPublishedForm();
    for (const window of [
      { opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt },
      { opensAt: WINDOW.opensAt, closesAt: WINDOW.opensAt },
      { opensAt: 'soon', closesAt: WINDOW.closesAt },
      { opensAt: WINDOW.opensAt, closesAt: 'later' },
    ]) {
      expect(expectError(scheduleForm(published, window, NOW_SCHEDULING)).code, JSON.stringify(window)).toBe('FORM_WINDOW_INVALID');
    }
    expect(expectError(scheduleForm(published, WINDOW, '2026-10-21T12:00:00.000Z')).code).toBe('FORM_WINDOW_INVALID');
    expect(scheduleForm(published, WINDOW, '2026-10-21T11:59:59.999Z').ok).toBe(true);
  });

  it('opens a scheduled form once its window has begun, and not before', () => {
    const scheduled = aScheduledForm();
    expect(expectError(openForm(scheduled, '2026-10-21T07:59:59.999Z')).code).toBe('FORM_WINDOW_NOT_YET_OPEN');
    expect(expectValue(openForm(scheduled, WINDOW.opensAt)).state).toBe('active');
  });

  it('closes an open form once its window has ended, and not before', () => {
    const active = anActiveForm();
    expect(expectError(closeForm(active, '2026-10-21T11:59:59.999Z')).code).toBe('FORM_WINDOW_STILL_OPEN');
    const closed = expectValue(closeForm(active, WINDOW.closesAt));
    expect(closed.state).toBe('closed');
    expect(closed.scheduleWindow).toEqual(WINDOW);
  });

  it('refuses a malformed now on each', () => {
    expect(expectError(scheduleForm(aPublishedForm(), WINDOW, 'x')).code).toBe('FORM_NOW_INVALID');
    expect(expectError(openForm(aScheduledForm(), 'x')).code).toBe('FORM_NOW_INVALID');
    expect(expectError(closeForm(anActiveForm(), 'x')).code).toBe('FORM_NOW_INVALID');
  });

  it('refuses each from any state its table does not allow, naming the pair', () => {
    expect(expectError(scheduleForm(aDraftForm(), WINDOW, NOW_SCHEDULING)).code).toBe('FORM_TRANSITION_PROHIBITED');
    expect(expectError(scheduleForm(aScheduledForm(), WINDOW, NOW_SCHEDULING)).message).toContain('embargoed');
    expect(expectError(openForm(aPublishedForm(), WITHIN_WINDOW)).code).toBe('FORM_TRANSITION_PROHIBITED');
    expect(expectError(openForm(anActiveForm(), WITHIN_WINDOW)).code).toBe('FORM_TRANSITION_PROHIBITED');
    expect(expectError(closeForm(aScheduledForm(), WINDOW.closesAt)).code).toBe('FORM_TRANSITION_PROHIBITED');
    expect(expectError(closeForm(aClosedForm(), WINDOW.closesAt)).code).toBe('FORM_TRANSITION_PROHIBITED');
  });

  it('every state past draft refuses a substitution, not just published: a form never thaws', () => {
    for (const form of [aPublishedForm(), aScheduledForm(), anActiveForm(), aClosedForm()]) {
      expect(expectError(substituteSlot(form, slotsOf(form)[0]!.slotId, { itemId: id(TAG.item, 50), itemVersionId: id(TAG.itemVersion, 50), stimulusVersionId: null, isAnchor: false })).code, form.state).toBe('FORM_IS_PUBLISHED');
    }
  });
});

describe('restoring a form from storage', () => {
  const snapshot = (overrides: Partial<FormSnapshot> = {}): FormSnapshot => ({ ...formProps(), state: 'draft', publishedAt: null, scheduleWindow: null, ...overrides });

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

  it('restores each scheduled state with its window', () => {
    for (const state of ['embargoed', 'active', 'closed'] as const) {
      const restored = expectValue(restoreForm(snapshot({ state, publishedAt: NOW, scheduleWindow: WINDOW })));
      expect(restored.state).toBe(state);
      expect(restored.scheduleWindow).toEqual(WINDOW);
      expect(Object.isFrozen(restored.scheduleWindow)).toBe(true);
    }
  });

  it('refuses a window that disagrees with the state: a scheduled state without one, or one without a scheduled state', () => {
    expect(expectError(restoreForm(snapshot({ state: 'active', publishedAt: NOW }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'published', publishedAt: NOW, scheduleWindow: WINDOW }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'embargoed', publishedAt: NOW, scheduleWindow: { opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt } }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'embargoed', publishedAt: NOW, scheduleWindow: { opensAt: 'x', closesAt: WINDOW.closesAt } }))).code).toBe('FORM_STORED_STATE_INVALID');
    expect(expectError(restoreForm(snapshot({ state: 'embargoed', publishedAt: NOW, scheduleWindow: { opensAt: WINDOW.opensAt, closesAt: 'y' } }))).code).toBe('FORM_STORED_STATE_INVALID');
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
