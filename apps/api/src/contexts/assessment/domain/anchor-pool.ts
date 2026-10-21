import { ruleViolationError, validationError, type AssessmentError } from './assessment-error.js';
import { err, ok, type Result } from './result.js';
import { isPositiveInteger, isUtcTimestamp, isUuid } from './uuid.js';

/**
 * The anchor pool (ASSESSMENT-ENGINE §10): the stable set of item versions that
 * every form draws its common items from, so that two forms can be equated.
 *
 * **Membership is a stored fact, not a derivation.** An item version is in the
 * pool or it is not, because someone put it there and recorded when. Nothing
 * infers it from difficulty, usage or age — an anchor whose statistics drift
 * is not an anchor, and a membership that could change by recomputation would
 * drift with them.
 *
 * It is a pool of **versions**, for the same reason a response pins a version:
 * a revised item is a different item as far as equating is concerned.
 *
 * The pool is *reserved* (excluded from practice — there is no practice yet to
 * exclude it from, and the fact is here for when there is), *exposure-capped*
 * (a member past its cap is no longer offered) and *rotated slowly* (members
 * retire, and are never deleted or re-added).
 *
 * It lives in assessment although the context map gives anchors to
 * Psychometrics: ADR-0031.
 */
export interface AnchorPoolMember {
  readonly itemVersionId: string;
  /** The most forms this version may appear in as an anchor. */
  readonly exposureCap: number;
  readonly addedAt: string;
  /** Set once, when the version leaves the pool. `null` while it is a member. */
  readonly retiredAt: string | null;
}

export type AnchorPoolErrorCode =
  | 'ANCHOR_ITEM_VERSION_INVALID'
  | 'ANCHOR_CAP_INVALID'
  | 'ANCHOR_TIME_INVALID'
  | 'ANCHOR_ALREADY_RETIRED'
  | 'ANCHOR_RETIRED_BEFORE_ADDED';

export type AnchorPoolError = AssessmentError<AnchorPoolErrorCode>;

export function addAnchorPoolMember(props: {
  readonly itemVersionId: string;
  readonly exposureCap: number;
  readonly addedAt: string;
}): Result<AnchorPoolMember, AnchorPoolError> {
  if (!isUuid(props.itemVersionId)) {
    return err(validationError('ANCHOR_ITEM_VERSION_INVALID', 'itemVersionId must be a uuid', 'itemVersionId'));
  }
  if (!isPositiveInteger(props.exposureCap)) {
    return err(validationError('ANCHOR_CAP_INVALID', 'exposureCap is a positive whole number', 'exposureCap'));
  }
  if (!isUtcTimestamp(props.addedAt)) {
    return err(validationError('ANCHOR_TIME_INVALID', 'addedAt must be a UTC timestamp with milliseconds', 'addedAt'));
  }
  return ok(Object.freeze({ itemVersionId: props.itemVersionId, exposureCap: props.exposureCap, addedAt: props.addedAt, retiredAt: null }));
}

/** A version leaves the pool once; it is not deleted, and it does not come back. */
export function retireAnchorPoolMember(member: AnchorPoolMember, now: string): Result<AnchorPoolMember, AnchorPoolError> {
  if (!isUtcTimestamp(now)) return err(validationError('ANCHOR_TIME_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  if (member.retiredAt !== null) return err(ruleViolationError('ANCHOR_ALREADY_RETIRED', 'the version has already left the pool', 'retiredAt'));
  if (now < member.addedAt) {
    return err(validationError('ANCHOR_RETIRED_BEFORE_ADDED', 'a version cannot leave the pool before it joined', 'now'));
  }
  return ok(Object.freeze({ ...member, retiredAt: now }));
}

export function isActiveAnchor(member: AnchorPoolMember): boolean {
  return member.retiredAt === null;
}

/** The set a form is checked against: the item versions currently in the pool. */
export function activeAnchorVersions(members: readonly AnchorPoolMember[]): ReadonlySet<string> {
  return new Set(members.filter(isActiveAnchor).map((member) => member.itemVersionId));
}
