import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../platform/config/config.js';
import { createAttempt, type Attempt, type AttemptSlot, type CreateAttemptProps } from '../contexts/assessment/domain/attempt.js';
import { closeForm, createForm, openForm, publishForm, scheduleForm, slotsOf as slotsOfForm, type CreateFormProps, type Form, type FormSlot } from '../contexts/assessment/domain/form.js';
import { expectValue } from './expect-result.js';

/** Deterministic uuids: `n` in the last group, a tag in the first, so two kinds never collide. */
export function id(tag: number, n = 1): string {
  return `${tag.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const TAG = { attempt: 0xa1, student: 0xa2, form: 0xa3, profile: 0xa4, taxonomy: 0xa5, session: 0xa6, slot: 0xb1, item: 0xb2, itemVersion: 0xb3, stimulus: 0xb4, event: 0xc1 } as const;

/** The sitting the fixture forms are published for, and the one the fixture attempts sit. */
export const SESSION_REF = '2026-01-27/shift-2';

export const MARKING_HASH = 'a'.repeat(64);

export function slots(count = 3): AttemptSlot[] {
  return Array.from({ length: count }, (_, i) => ({
    slotId: id(TAG.slot, i + 1),
    ordinal: i + 1,
    itemId: id(TAG.item, i + 1),
    itemVersionId: id(TAG.itemVersion, i + 1),
    stimulusVersionId: i === 0 ? id(TAG.stimulus, 1) : null,
  }));
}

export function attemptProps(overrides: Partial<CreateAttemptProps> = {}): CreateAttemptProps {
  return {
    attemptId: id(TAG.attempt),
    studentId: id(TAG.student),
    mode: 'mock',
    formId: id(TAG.form),
    examProfileVersionId: id(TAG.profile),
    markingRuleSetHash: MARKING_HASH,
    taxonomyVersionId: id(TAG.taxonomy),
    deliveryPolicy: { timing: 'strict', navigation: 'free', pausable: false },
    sessionRef: SESSION_REF,
    shiftId: '2026-01-27/shift-2',
    slots: slots(),
    durationMs: 3 * 3_600_000,
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    windowClosesAt: '2026-10-21T12:00:00.000Z',
    createdAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

export function anAttempt(overrides: Partial<CreateAttemptProps> = {}): Attempt {
  return expectValue(createAttempt(attemptProps(overrides)));
}

/** Six slots in two sections; the first is an anchor, which is 16% — just over F50's floor. */
export function formSlots(): FormSlot[] {
  return Array.from({ length: 6 }, (_, i) => ({
    slotId: id(TAG.slot, i + 1),
    ordinal: i + 1,
    itemId: id(TAG.item, i + 1),
    itemVersionId: id(TAG.itemVersion, i + 1),
    stimulusVersionId: i === 0 ? id(TAG.stimulus, 1) : null,
    marksAvailable: 4,
    isAnchor: i === 0,
  }));
}

export function formProps(overrides: Partial<CreateFormProps> = {}): CreateFormProps {
  const all = formSlots();
  return {
    formId: id(TAG.form),
    examProfileVersionId: id(TAG.profile),
    formType: 'mock',
    sessionRefs: [SESSION_REF],
    blueprintConformance: { satisfied: true, sections: 2 },
    sections: [
      { ordinal: 1, sectionSpecRef: 'physics-a', slots: all.slice(0, 3) },
      { ordinal: 2, sectionSpecRef: 'physics-b', slots: all.slice(3) },
    ],
    ...overrides,
  };
}

export function aDraftForm(overrides: Partial<CreateFormProps> = {}): Form {
  return expectValue(createForm(formProps(overrides)));
}

/** The anchor pool that agrees with a form's own flags: exactly the item versions it flags as anchors. */
export function poolOf(form: Form): ReadonlySet<string> {
  return new Set(slotsOfForm(form).filter((slot) => slot.isAnchor).map((slot) => slot.itemVersionId));
}

/** The window the fixture attempts are sat in; their own `windowClosesAt` is the form's. */
export const WINDOW = { opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' } as const;
/** A moment inside that window. */
export const WITHIN_WINDOW = '2026-10-21T09:00:00.000Z';

export function aPublishedForm(overrides: Partial<CreateFormProps> = {}): Form {
  const draft = aDraftForm(overrides);
  return expectValue(publishForm(draft, '2026-10-21T07:00:00.000Z', poolOf(draft)));
}

export function aScheduledForm(overrides: Partial<CreateFormProps> = {}): Form {
  return expectValue(scheduleForm(aPublishedForm(overrides), WINDOW, '2026-10-21T07:30:00.000Z'));
}

export function anActiveForm(overrides: Partial<CreateFormProps> = {}): Form {
  return expectValue(openForm(aScheduledForm(overrides), WITHIN_WINDOW));
}

export function aClosedForm(overrides: Partial<CreateFormProps> = {}): Form {
  return expectValue(closeForm(anActiveForm(overrides), '2026-10-21T12:00:00.000Z'));
}
