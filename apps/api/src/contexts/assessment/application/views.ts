import type { Attempt } from '../domain/attempt.js';
import type { Form } from '../domain/form.js';

/**
 * The operator's view of a form. It names the item versions the form pins and
 * nothing about what is in them: **no stem, no option, no answer key, no
 * solution**, because a form pins versions and does not contain content. Built
 * field by field, so a field the domain gains next year does not cross unless
 * someone puts it here.
 */
export interface FormSlotView {
  readonly slotId: string;
  readonly ordinal: number;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly stimulusVersionId?: string;
  readonly marksAvailable: number;
  readonly isAnchor: boolean;
}

export interface FormView {
  readonly formId: string;
  readonly examProfileVersionId: string;
  readonly formType: 'mock' | 'diagnostic';
  readonly state: string;
  readonly sessionRefs: readonly string[];
  readonly publishedAt?: string;
  readonly scheduleWindow?: { readonly opensAt: string; readonly closesAt: string };
  readonly blueprintConformance: Readonly<Record<string, unknown>>;
  readonly sections: readonly {
    readonly ordinal: number;
    readonly sectionSpecRef: string;
    readonly slots: readonly FormSlotView[];
  }[];
}

export function toFormView(form: Form): FormView {
  return Object.freeze({
    formId: form.formId,
    examProfileVersionId: form.examProfileVersionId,
    formType: form.formType,
    state: form.state,
    sessionRefs: Object.freeze([...form.sessionRefs]),
    ...(form.publishedAt === null ? {} : { publishedAt: form.publishedAt }),
    ...(form.scheduleWindow === null ? {} : { scheduleWindow: Object.freeze({ opensAt: form.scheduleWindow.opensAt, closesAt: form.scheduleWindow.closesAt }) }),
    blueprintConformance: form.blueprintConformance,
    sections: Object.freeze(
      form.sections.map((section) =>
        Object.freeze({
          ordinal: section.ordinal,
          sectionSpecRef: section.sectionSpecRef,
          slots: Object.freeze(
            section.slots.map((slot) =>
              Object.freeze({
                slotId: slot.slotId,
                ordinal: slot.ordinal,
                itemId: slot.itemId,
                itemVersionId: slot.itemVersionId,
                ...(slot.stimulusVersionId === null ? {} : { stimulusVersionId: slot.stimulusVersionId }),
                marksAvailable: slot.marksAvailable,
                isAnchor: slot.isAnchor,
              }),
            ),
          ),
        }),
      ),
    ),
  });
}


/**
 * An attempt as its student sees it. **The deadline is the server's**, and `serverNow` lets the device compute its
 * offset once and enforce locally against monotonic time. No slot, item version or key: the package carries what is shown.
 */
export interface AttemptView {
  readonly attemptId: string;
  readonly formId: string;
  readonly mode: string;
  readonly state: string;
  readonly sessionRef: string;
  readonly shiftId: string;
  readonly slotCount: number;
  readonly durationMs: number;
  /** The one cap on a visit's time on item, pinned for this attempt: the device projects with this value and no other. */
  readonly intervalCapMs: number;
  readonly windowClosesAt: string;
  readonly startedAt: string | null;
  readonly deadline: string | null;
  readonly serverNow: string;
  readonly submission: { readonly reason: string; readonly submittedAt: string; readonly pastDeadline: boolean } | null;
}

export function toAttemptView(attempt: Attempt, serverNow: string): AttemptView {
  return Object.freeze({
    attemptId: attempt.attemptId,
    formId: attempt.formId,
    mode: attempt.mode,
    state: attempt.state,
    sessionRef: attempt.sessionRef,
    shiftId: attempt.shiftId,
    slotCount: attempt.slots.length,
    durationMs: attempt.durationMs,
    intervalCapMs: attempt.intervalCapMs,
    windowClosesAt: attempt.windowClosesAt,
    startedAt: attempt.startedAt,
    deadline: attempt.deadline,
    serverNow,
    submission:
      attempt.submission === null
        ? null
        : Object.freeze({
            reason: attempt.submission.reason,
            submittedAt: attempt.submission.submittedAt,
            pastDeadline: attempt.deadline !== null && attempt.submission.submittedAt >= attempt.deadline,
          }),
  });
}
