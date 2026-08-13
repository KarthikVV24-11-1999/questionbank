import type { ContentBody } from '../../domain/content-body.js';
import type { CreateLicensingStatusProps } from '../../domain/licensing-status.js';
import type { StimulusType } from '../../domain/stimulus.js';

/**
 * FR-TCH-03. A stimulus is a first-class object, created once and attached to
 * many items — never pasted per item, which DOMAIN-MODEL §5 calls the
 * category's canonical fatal error.
 *
 * `subject` narrows the authoring role (FR-TCH-01 rule 1); it is scope, not
 * content, which is why it is on the command and not on the body.
 */

export interface CreateStimulusDraft {
  readonly stimulusType: StimulusType;
  readonly subject: string;
  readonly body: ContentBody;
  readonly licensing?: CreateLicensingStatusProps;
}

/** Autosave for a stimulus draft, on the same idempotency contract as an item's. */
export interface UpdateStimulusDraft {
  readonly stimulusId: string;
  readonly subject: string;
  readonly body: ContentBody;
  readonly licensing?: CreateLicensingStatusProps;
  readonly idempotencyKey: string;
}

/**
 * Pins the stimulus version current at attachment time (FR-TCH-03 rule 2). The
 * command names a *stimulus*, and the handler resolves which version that is —
 * a caller naming a version could pin one the author never saw.
 */
export interface AttachStimulusToItem {
  readonly itemId: string;
  readonly stimulusId: string;
}
