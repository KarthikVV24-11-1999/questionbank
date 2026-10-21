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
