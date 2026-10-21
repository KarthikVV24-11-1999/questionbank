import { preconditionFailedError, type AssessmentError } from './assessment-error.js';
import type { Form } from './form.js';
import { slotsOf } from './form.js';
import { err, ok, type Result } from './result.js';

/**
 * The exposure ledger (ASSESSMENT-ENGINE §6, §12): which item version was put
 * in front of how many forms, and under which session.
 *
 * **Written at publication, not at attempt time.** The form's composition is
 * what determines exposure, and it must be known before students arrive — so
 * the ledger is a function of a *published form* and nothing else, and there
 * is no operation here that takes an attempt. The one place rows are written
 * is the publication transaction (M6-19), which makes "a form published twice
 * does not double-count" and "no attempt-time path writes it" the same fact.
 *
 * Each row keys on the form, the slot's item version and the session identity
 * (§12 requires all three and says they cannot be reconstructed).
 *
 * It lives in assessment although the context map gives exposure to
 * Psychometrics: ADR-0031.
 */
export interface ExposureEntry {
  readonly formId: string;
  readonly slotId: string;
  readonly itemId: string;
  /** The version, not the item: statistics attach to the version a response was sat on. */
  readonly itemVersionId: string;
  readonly sessionRef: string;
  readonly isAnchor: boolean;
  readonly writtenAt: string;
}

export type ExposureErrorCode = 'EXPOSURE_FORM_NOT_PUBLISHED';
export type ExposureError = AssessmentError<ExposureErrorCode>;

/** One entry per slot of a published form. A draft has no exposure: it may still change. */
export function exposureEntriesOf(form: Form): Result<readonly ExposureEntry[], ExposureError> {
  if (form.publishedAt === null) {
    return err(preconditionFailedError('EXPOSURE_FORM_NOT_PUBLISHED', 'exposure is recorded for a published form only', 'state'));
  }
  const writtenAt = form.publishedAt;
  return ok(
    Object.freeze(
      slotsOf(form).map((slot) =>
        Object.freeze({
          formId: form.formId,
          slotId: slot.slotId,
          itemId: slot.itemId,
          itemVersionId: slot.itemVersionId,
          sessionRef: form.sessionRef,
          isAnchor: slot.isAnchor,
          writtenAt,
        }),
      ),
    ),
  );
}
