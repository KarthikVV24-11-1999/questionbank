import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';

/**
 * `LicensingStatus` — may this content be reproduced, and on what terms
 * (DOMAIN-MODEL §5, FR-QM-05).
 *
 * **`unresolved` blocks publication unconditionally** (FR-QM-05 rule 4, "no
 * exceptions"). It is also the **default for a new draft**: an author must make
 * a positive statement about rights rather than inherit a permissive one from
 * a form field nobody filled in. Defaulting the other way is how a corpus ends
 * up with content nobody can account for, and DECISIONS §D item 2 — the open
 * content licensing and IP policy, flagged against existential risk R5 — is
 * exactly the question that would then have no answer.
 *
 * **Expiry is evaluated against a supplied instant**, never a clock read here.
 * The domain stays pure for the same reason scoring's does: a publication
 * decision that depends on when it happened to run is not reproducible.
 */

export const LICENSING_STATUSES = ['owned', 'licensed', 'public_domain', 'unresolved'] as const;
export type LicensingStatusKind = (typeof LICENSING_STATUSES)[number];

export interface LicensingStatus {
  readonly status: LicensingStatusKind;
  readonly licenseRef?: string;
  readonly attribution?: string;
  readonly expiresAt?: string;
}

export type LicensingErrorCode =
  | 'LICENSING_STATUS_UNKNOWN'
  | 'LICENSE_REF_REQUIRED'
  | 'ATTRIBUTION_REQUIRED'
  | 'EXPIRY_NOT_A_TIMESTAMP'
  | 'EXPIRY_ON_UNEXPIRING_STATUS';

export type LicensingError = ContentError<LicensingErrorCode>;

export type CreateLicensingStatusProps = LicensingStatus;

/**
 * What a new draft starts as. Not a convenience — the whole point is that the
 * permissive statement has to be made deliberately.
 */
export const UNRESOLVED_LICENSING: LicensingStatus = Object.freeze({ status: 'unresolved' });

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function invalid(code: LicensingErrorCode, message: string, location: string): LicensingError {
  return validationError(code, message, location);
}

/** ISO-8601 instants only, so ordering is lexicographic and comparison needs no clock. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function createLicensingStatus(
  props: CreateLicensingStatusProps,
  location = 'licensing',
): Result<LicensingStatus, LicensingError> {
  if (!(LICENSING_STATUSES as readonly string[]).includes(props.status)) {
    return err(
      invalid('LICENSING_STATUS_UNKNOWN', `unknown licensing status "${props.status}"`, location),
    );
  }

  if (props.status === 'licensed') {
    if (isBlank(props.licenseRef)) {
      return err(
        invalid('LICENSE_REF_REQUIRED', 'a licensed item requires a licenseRef naming the licence', location),
      );
    }
    if (isBlank(props.attribution)) {
      return err(
        invalid('ATTRIBUTION_REQUIRED', 'a licensed item requires the attribution its licence demands', location),
      );
    }
  }

  if (props.expiresAt !== undefined) {
    if (!ISO_INSTANT.test(props.expiresAt)) {
      return err(
        invalid('EXPIRY_NOT_A_TIMESTAMP', `expiresAt "${props.expiresAt}" is not an ISO-8601 instant`, location),
      );
    }
    // Only a licence runs out. An expiry on `owned` or `public_domain` is
    // either a mistake or a licence mislabelled as ownership, and silently
    // ignoring it would hide the second case.
    if (props.status !== 'licensed') {
      return err(
        invalid(
          'EXPIRY_ON_UNEXPIRING_STATUS',
          `status ${props.status} does not expire; an expiry here suggests it is really a licence`,
          location,
        ),
      );
    }
  }

  return ok(Object.freeze({ ...props }));
}

export interface LicensingEvaluation {
  /** The instant publication is being evaluated at, supplied by the caller. */
  readonly asOf: string;
}

/**
 * Whether this status permits publication at a supplied instant.
 *
 * `unresolved` never does. A `licensed` status whose expiry has passed does
 * not either — the licence that made it publishable is the thing that ran out,
 * and continuing to serve it is the same exposure as never having had one.
 * Expiry is inclusive of the instant itself: a licence expiring at *t* is
 * expired at *t*.
 */
export function isPublishable(licensing: LicensingStatus, evaluation: LicensingEvaluation): boolean {
  if (licensing.status === 'unresolved') return false;
  if (licensing.expiresAt === undefined) return true;
  return evaluation.asOf < licensing.expiresAt;
}

/** Why publication is refused, for the validation panel. */
export function publicationBlockReason(
  licensing: LicensingStatus,
  evaluation: LicensingEvaluation,
): string | undefined {
  if (licensing.status === 'unresolved') {
    return 'licensing is unresolved, which blocks publication unconditionally (FR-QM-05 rule 4)';
  }
  if (licensing.expiresAt !== undefined && evaluation.asOf >= licensing.expiresAt) {
    return `the licence expired at ${licensing.expiresAt}`;
  }
  return undefined;
}
