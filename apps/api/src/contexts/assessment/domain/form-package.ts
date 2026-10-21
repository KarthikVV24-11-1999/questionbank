import { preconditionFailedError, validationError, type AssessmentError } from './assessment-error.js';
import type { Form } from './form.js';
import { err, ok, type Result } from './result.js';

/**
 * The form package (M6-24): the bytes a learner's device downloads to sit a form,
 * built from an `active` form and from nothing else.
 *
 * **Content is taken from the form's pins and handed in, not resolved here.** A
 * form pins item and stimulus *versions*; the package carries exactly those, and
 * the caller supplies the delivery view of each by version id. A package that
 * re-resolved items would serve whatever is current, and could drift from what an
 * attempt was pinned to (INV-04).
 *
 * **What it deliberately leaves out.** The anchor flag (a student has no business
 * knowing which items equate forms), the blueprint report, the marking rule set,
 * the exposure ledger — and, above all, any answer key or solution. The content
 * it carries is opaque JSON here: this module neither knows nor imports what an
 * item view contains. That it contains no key is proven where the bytes are made,
 * by scanning them (M6-25); this module's own part is that it never reaches the
 * place a key is made (a fitness rule walks its imports).
 *
 * **Byte-identical for the same form.** Keys are written in sorted order, nothing
 * is time-stamped at build, and every list is in a fixed order, so building twice
 * gives the same bytes — which is what lets a digest and a signature mean something.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const FORM_PACKAGE_FORMAT = 'questionbank.form-package';
export const FORM_PACKAGE_FORMAT_VERSION = 1;

/** The delivery views a package is made of, keyed by the version id the form pinned. */
export interface PackageContent {
  readonly items: ReadonlyMap<string, JsonValue>;
  readonly stimuli: ReadonlyMap<string, JsonValue>;
}

export interface FormPackage {
  readonly formId: string;
  readonly bytes: Uint8Array;
  /** Every slot, once, in form order. */
  readonly slotIds: readonly string[];
}

export type FormPackageErrorCode =
  | 'PACKAGE_FORM_NOT_ACTIVE'
  | 'PACKAGE_ITEM_MISSING'
  | 'PACKAGE_STIMULUS_MISSING'
  | 'PACKAGE_CONTENT_NOT_PINNED'
  | 'PACKAGE_VIEW_DISAGREES_WITH_PIN';

export type FormPackageError = AssessmentError<FormPackageErrorCode>;

/** JSON with every object's keys in sorted order, recursively: the one serialization, so equal values are equal bytes. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, (inner as Record<string, unknown>)[key]]),
        )
      : inner,
  );
}

function versionOf(view: JsonValue, field: string): string | undefined {
  const value = typeof view === 'object' && view !== null && !Array.isArray(view) ? (view as { readonly [key: string]: JsonValue })[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function buildFormPackage(form: Form, content: PackageContent): Result<FormPackage, FormPackageError> {
  if (form.state !== 'active' || form.scheduleWindow === null) {
    return err(preconditionFailedError('PACKAGE_FORM_NOT_ACTIVE', `a package is built from an active form; this one is ${form.state}`, 'state'));
  }

  const pinnedItems = new Set(form.sections.flatMap((section) => section.slots.map((slot) => slot.itemVersionId)));
  const pinnedStimuli = new Set(form.sections.flatMap((section) => section.slots.flatMap((slot) => (slot.stimulusVersionId === null ? [] : [slot.stimulusVersionId]))));

  for (const id of content.items.keys()) {
    if (!pinnedItems.has(id)) return err(validationError('PACKAGE_CONTENT_NOT_PINNED', `item version ${id} is not one the form pinned`, 'items'));
  }
  for (const id of content.stimuli.keys()) {
    if (!pinnedStimuli.has(id)) return err(validationError('PACKAGE_CONTENT_NOT_PINNED', `stimulus version ${id} is not one the form pinned`, 'stimuli'));
  }

  const sections: JsonValue[] = [];
  for (const section of form.sections) {
    const slots: JsonValue[] = [];
    for (const slot of section.slots) {
      const item = content.items.get(slot.itemVersionId);
      if (item === undefined) return err(validationError('PACKAGE_ITEM_MISSING', `no content for item version ${slot.itemVersionId}`, slot.slotId));
      if (versionOf(item, 'itemVersionId') !== slot.itemVersionId) {
        return err(validationError('PACKAGE_VIEW_DISAGREES_WITH_PIN', `the view supplied for ${slot.itemVersionId} is for another version`, slot.slotId));
      }
      if (slot.stimulusVersionId !== null && !content.stimuli.has(slot.stimulusVersionId)) {
        return err(validationError('PACKAGE_STIMULUS_MISSING', `no content for stimulus version ${slot.stimulusVersionId}`, slot.slotId));
      }
      slots.push({
        slotId: slot.slotId,
        ordinal: slot.ordinal,
        marksAvailable: slot.marksAvailable,
        itemVersionId: slot.itemVersionId,
        ...(slot.stimulusVersionId === null ? {} : { stimulusVersionId: slot.stimulusVersionId }),
        item,
      });
    }
    sections.push({ ordinal: section.ordinal, sectionSpecRef: section.sectionSpecRef, slots });
  }

  const stimuli: JsonValue[] = [...content.stimuli.keys()].sort().map((id) => ({ stimulusVersionId: id, view: content.stimuli.get(id) as JsonValue }));

  const document: JsonValue = {
    format: FORM_PACKAGE_FORMAT,
    formatVersion: FORM_PACKAGE_FORMAT_VERSION,
    form: {
      formId: form.formId,
      examProfileVersionId: form.examProfileVersionId,
      formType: form.formType,
      sessionRefs: [...form.sessionRefs],
      publishedAt: form.publishedAt as string,
      window: { opensAt: form.scheduleWindow.opensAt, closesAt: form.scheduleWindow.closesAt },
    },
    sections,
    stimuli,
  };

  return ok(
    Object.freeze({
      formId: form.formId,
      bytes: new TextEncoder().encode(canonicalJson(document)),
      slotIds: Object.freeze(form.sections.flatMap((section) => section.slots.map((slot) => slot.slotId))),
    }),
  );
}
