import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { WITHIN_WINDOW, anActiveForm, TAG, aDraftForm, aPublishedForm, anAttempt, attemptProps, formSlots, id } from '../../../testing/assessment-fixtures.js';
import { createAttempt, startAttempt } from './attempt.js';
import { createForm, createAttemptFromForm, slotsOf } from './form.js';
import { acceptResponseEvent } from './response-event.js';

/**
 * ASSESSMENT-ENGINE §12 — what must be captured from the first attempt because
 * it cannot be reconstructed. One test per row that is in scope for M6, each
 * asking the domain to hold the value as null and expecting it to refuse.
 *
 * The seventh row, ability estimates at each step, is for practice attempts
 * only (H1). A mock has no adaptive step to estimate at, so there is nothing
 * to capture here and nothing to test.
 */
const NOW = '2026-10-21T09:05:00.000Z';
const live = () => expectValue(startAttempt(anAttempt(), '2026-10-21T09:00:00.000Z'));
const event = {
  eventId: id(TAG.event, 1),
  attemptId: id(TAG.attempt),
  slotId: id(TAG.slot, 1),
  sequence: 1,
  kind: 'select' as const,
  answer: 'A',
  clientMonotonicMs: 1000,
  deviceRef: 'phone-1',
};

describe('§12 capture requirements', () => {
  it('anchor items in every form: a slot cannot omit whether it is an anchor', () => {
    for (const isAnchor of [undefined, null, 'yes', 1]) {
      const slots = formSlots().map((slot, i) => (i === 0 ? { ...slot, isAnchor: isAnchor as unknown as boolean } : slot));
      expect(expectError(createForm({ ...aDraftForm(), sections: [{ ordinal: 1, sectionSpecRef: 'a', slots }] })).code).toBe('FORM_SLOT_INVALID');
    }
  });

  it('per-item exposure with form and session identity: the form names every item version and the attempt names its session', () => {
    const form = anActiveForm();
    expect(slotsOf(form).every((slot) => slot.itemVersionId.length > 0)).toBe(true);
    const attempt = expectValue(createAttemptFromForm(form, { ...attemptProps(), createdAt: '2026-10-21T08:00:00.000Z' }, WITHIN_WINDOW));
    expect(attempt.formId).toBe(form.formId);
    expect(attempt.sessionId).toBe(id(TAG.session));
    expect(expectError(createAttempt(attemptProps({ sessionId: null as unknown as string }))).code).toBe('ATTEMPT_SESSION_INVALID');
  });

  it('per-item response timing: an event cannot omit the device\'s monotonic reading', () => {
    for (const clientMonotonicMs of [undefined, null, -1]) {
      const draft = { ...event, clientMonotonicMs: clientMonotonicMs as unknown as number };
      expect(expectError(acceptResponseEvent(live(), draft, NOW)).code).toBe('EVENT_TIMING_INVALID');
    }
  });

  it('the full answer-change sequence: every change is kept as its own event', () => {
    const attempt = live();
    const sequence = [1, 2, 3, 4].map((n) =>
      expectValue(acceptResponseEvent(attempt, { ...event, eventId: id(TAG.event, n), sequence: n, kind: n === 1 ? 'select' : 'change', answer: `opt${n}` }, NOW)),
    );
    expect(sequence.filter((e) => e.kind === 'change')).toHaveLength(3);
    expect(sequence.map((e) => e.answer)).toEqual(['opt1', 'opt2', 'opt3', 'opt4']);
  });

  it('attempt-level session and shift identity: neither can be absent', () => {
    for (const shiftId of [undefined, null, '', '  ']) {
      expect(expectError(createAttempt(attemptProps({ shiftId: shiftId as unknown as string }))).code).toBe('ATTEMPT_SHIFT_INVALID');
    }
    for (const sessionId of [undefined, null, '', 'not-a-uuid']) {
      expect(expectError(createAttempt(attemptProps({ sessionId: sessionId as unknown as string }))).code).toBe('ATTEMPT_SESSION_INVALID');
    }
  });

  it('item version pinned per response: the version comes from the slot, so no response can lack one or carry the wrong one', () => {
    const attempt = live();
    for (const slot of attempt.slots) {
      const stored = expectValue(acceptResponseEvent(attempt, { ...event, slotId: slot.slotId }, NOW));
      expect(stored.itemVersionId).toBe(slot.itemVersionId);
      expect(stored.itemVersionId).not.toBe(slot.itemId);
    }
    expect(expectError(acceptResponseEvent(attempt, { ...event, slotId: id(TAG.slot, 77) }, NOW)).code).toBe('EVENT_SLOT_NOT_IN_ATTEMPT');
  });
});
