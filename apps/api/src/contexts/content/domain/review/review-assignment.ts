import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../result.js';
import { conflictError, ruleViolationError, validationError, type ContentError } from '../content-error.js';

/**
 * `ReviewAssignment` — the record the review queue is made of (DEC-M4-9).
 *
 * **Pull with a lease, plus push for escalation.** `kind` records how the
 * assignment came to exist — `claimed` (a reviewer pulled it),
 * `assigned` (Content Ops pushed it, handling an escalation), or
 * `second_review` (QC sampling, M4-11) — and does not change once set.
 * `state` is the lifecycle every assignment moves through, starting at
 * `claimed` regardless of `kind`: the record is live the moment it exists,
 * whether a reviewer pulled it or Content Ops pushed it.
 *
 * **`leaseExpiresAt` is supplied, never computed here.** The caller derives it
 * from `claimedAt` and the `ReviewPolicy`'s lease hours (M4-05, M4-26); the
 * domain reads no clock and owns no policy default, so a lease is
 * reproducible from its own recorded facts.
 *
 * **Immutable, with no mutator.** A state change returns a new instance —
 * `transitionReviewAssignment` — the same discipline `ItemVersion` uses and
 * for the same reason: an assignment that could be edited in place could not
 * be an audit fact.
 *
 * **At most one live assignment per item version is a domain rule, proven
 * twice.** `assertClaimable` is the pure half — refusing a second claim
 * against a list of existing assignments the caller supplies. M4-18's
 * `SELECT … FOR UPDATE SKIP LOCKED` is the half that makes it atomic under
 * concurrency; neither replaces the other.
 */

export const REVIEW_ASSIGNMENT_KINDS = ['claimed', 'assigned', 'second_review'] as const;
export type ReviewAssignmentKind = (typeof REVIEW_ASSIGNMENT_KINDS)[number];

/**
 * `claimed` is both the assignment's initial state and one of its `kind`s —
 * two different questions ("how did this come to exist" vs. "where is it in
 * its lifecycle") that happen to share a word. `ReviewAssignment` keeps them
 * in separate fields so neither reading has to be inferred from the other.
 */
export const REVIEW_ASSIGNMENT_STATES = ['claimed', 'decided', 'released', 'expired'] as const;
export type ReviewAssignmentState = (typeof REVIEW_ASSIGNMENT_STATES)[number];

/**
 * The transition table (M4-02's acceptance criterion). Every pair not listed
 * here is refused — including a state transitioning to itself, and every
 * transition out of a terminal state. `checkReviewAssignmentTransitionMatrix`
 * below walks all sixteen pairs; this table is what it walks against.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ReviewAssignmentState, readonly ReviewAssignmentState[]>> = {
  claimed: ['decided', 'released', 'expired'],
  decided: [],
  released: [],
  expired: [],
};

export interface ReviewAssignment {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly reviewer: PrincipalRef;
  readonly kind: ReviewAssignmentKind;
  readonly state: ReviewAssignmentState;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly releasedAt?: string;
  readonly decidedAt?: string;
}

export type ReviewAssignmentErrorCode =
  | 'ASSIGNMENT_ID_REQUIRED'
  | 'ITEM_ID_REQUIRED'
  | 'ITEM_VERSION_ID_REQUIRED'
  | 'SUBJECT_REQUIRED'
  | 'REVIEWER_REQUIRED'
  | 'REVIEWER_KIND_UNKNOWN'
  | 'KIND_UNKNOWN'
  | 'CLAIMED_AT_NOT_A_TIMESTAMP'
  | 'LEASE_EXPIRES_AT_NOT_A_TIMESTAMP'
  | 'LEASE_BEFORE_CLAIM'
  | 'TRANSITION_NOT_PERMITTED'
  | 'AT_NOT_A_TIMESTAMP'
  | 'LIVE_ASSIGNMENT_EXISTS';

export type ReviewAssignmentError = ContentError<ReviewAssignmentErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const PRINCIPAL_KINDS = ['human', 'ai_agent', 'system'] as const;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: ReviewAssignmentErrorCode, message: string, location: string): ReviewAssignmentError {
  return validationError(code, message, location);
}

function conflict(code: ReviewAssignmentErrorCode, message: string, location: string): ReviewAssignmentError {
  return conflictError(code, message, location);
}

function ruleViolation(code: ReviewAssignmentErrorCode, message: string, location: string): ReviewAssignmentError {
  return ruleViolationError(code, message, location);
}

function freezePrincipal(principal: PrincipalRef): PrincipalRef {
  return Object.freeze({ ...principal, roleContext: Object.freeze([...principal.roleContext]) });
}

export interface CreateReviewAssignmentProps {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly reviewer: PrincipalRef;
  readonly kind: ReviewAssignmentKind;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export function createReviewAssignment(
  props: CreateReviewAssignmentProps,
  location = 'reviewAssignment',
): Result<ReviewAssignment, ReviewAssignmentError> {
  if (isBlank(props.assignmentId)) {
    return err(invalid('ASSIGNMENT_ID_REQUIRED', 'a review assignment requires an assignmentId', location));
  }
  if (isBlank(props.itemId)) {
    return err(invalid('ITEM_ID_REQUIRED', 'a review assignment names the item it covers', `${location}.itemId`));
  }
  if (isBlank(props.itemVersionId)) {
    return err(
      invalid(
        'ITEM_VERSION_ID_REQUIRED',
        'a review assignment names the item version it covers',
        `${location}.itemVersionId`,
      ),
    );
  }
  if (isBlank(props.subject)) {
    return err(
      invalid('SUBJECT_REQUIRED', 'a review assignment is subject-scoped (D23, DEC-M4-8)', `${location}.subject`),
    );
  }
  if (isBlank(props.reviewer.id)) {
    return err(invalid('REVIEWER_REQUIRED', 'a review assignment records who holds it', `${location}.reviewer`));
  }
  if (!(PRINCIPAL_KINDS as readonly string[]).includes(props.reviewer.kind)) {
    return err(
      invalid(
        'REVIEWER_KIND_UNKNOWN',
        `unknown principal kind "${props.reviewer.kind}"`,
        `${location}.reviewer`,
      ),
    );
  }
  if (!(REVIEW_ASSIGNMENT_KINDS as readonly string[]).includes(props.kind)) {
    return err(invalid('KIND_UNKNOWN', `unknown review assignment kind "${props.kind}"`, `${location}.kind`));
  }
  if (!ISO_INSTANT.test(props.claimedAt)) {
    return err(
      invalid(
        'CLAIMED_AT_NOT_A_TIMESTAMP',
        `claimedAt "${props.claimedAt}" is not an ISO-8601 instant`,
        `${location}.claimedAt`,
      ),
    );
  }
  if (!ISO_INSTANT.test(props.leaseExpiresAt)) {
    return err(
      invalid(
        'LEASE_EXPIRES_AT_NOT_A_TIMESTAMP',
        `leaseExpiresAt "${props.leaseExpiresAt}" is not an ISO-8601 instant`,
        `${location}.leaseExpiresAt`,
      ),
    );
  }
  if (props.leaseExpiresAt <= props.claimedAt) {
    return err(
      invalid(
        'LEASE_BEFORE_CLAIM',
        `leaseExpiresAt "${props.leaseExpiresAt}" does not come after claimedAt "${props.claimedAt}"`,
        `${location}.leaseExpiresAt`,
      ),
    );
  }

  return ok(
    Object.freeze({
      assignmentId: props.assignmentId,
      itemId: props.itemId,
      itemVersionId: props.itemVersionId,
      subject: props.subject,
      reviewer: freezePrincipal(props.reviewer),
      kind: props.kind,
      state: 'claimed' as const,
      claimedAt: props.claimedAt,
      leaseExpiresAt: props.leaseExpiresAt,
    }),
  );
}

/**
 * The only way an assignment's state moves. Every pair `ALLOWED_TRANSITIONS`
 * does not name is refused, with the attempted transition named in the
 * message — including the no-op of a state "transitioning" to itself.
 */
export function transitionReviewAssignment(
  assignment: ReviewAssignment,
  to: ReviewAssignmentState,
  at: string,
  location = 'reviewAssignment',
): Result<ReviewAssignment, ReviewAssignmentError> {
  if (!ALLOWED_TRANSITIONS[assignment.state].includes(to)) {
    return err(
      ruleViolation(
        'TRANSITION_NOT_PERMITTED',
        `a review assignment cannot move from "${assignment.state}" to "${to}"`,
        location,
      ),
    );
  }
  if (!ISO_INSTANT.test(at)) {
    return err(invalid('AT_NOT_A_TIMESTAMP', `"${at}" is not an ISO-8601 instant`, `${location}.at`));
  }

  const stamp = to === 'decided' ? { decidedAt: at } : to === 'released' ? { releasedAt: at } : {};

  return ok(Object.freeze({ ...assignment, state: to, ...stamp }));
}

/** Pure over a supplied instant — no clock in the domain. Inclusive at the boundary. */
export function isExpired(assignment: ReviewAssignment, now: string): boolean {
  return now >= assignment.leaseExpiresAt;
}

function isLive(assignment: ReviewAssignment): boolean {
  return assignment.state === 'claimed';
}

/**
 * The domain half of "at most one live assignment per item version"
 * (M4-02's acceptance criterion; M4-18's `SELECT … FOR UPDATE SKIP LOCKED`
 * is the concurrency-safe half). `existing` is supplied by the caller —
 * the domain does not query.
 */
export function assertClaimable(
  existing: readonly ReviewAssignment[],
  itemVersionId: string,
  location = 'reviewAssignment',
): Result<true, ReviewAssignmentError> {
  const hasLiveAssignment = existing.some(
    (assignment) => assignment.itemVersionId === itemVersionId && isLive(assignment),
  );
  if (hasLiveAssignment) {
    return err(
      conflict(
        'LIVE_ASSIGNMENT_EXISTS',
        `item version ${itemVersionId} already has a live review assignment`,
        location,
      ),
    );
  }
  return ok(true);
}
