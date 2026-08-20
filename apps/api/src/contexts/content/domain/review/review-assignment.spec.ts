import { describe, expect, it } from 'vitest';
import { REVIEWER } from '../../../../testing/content-fixtures.js';
import {
  REVIEW_ASSIGNMENT_KINDS,
  REVIEW_ASSIGNMENT_STATES,
  assertClaimable,
  createReviewAssignment,
  isExpired,
  transitionReviewAssignment,
  type ReviewAssignment,
  type ReviewAssignmentState,
} from './review-assignment.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const CLAIMED_AT = '2026-08-19T10:00:00Z';
const LEASE_EXPIRES_AT = '2026-08-19T14:00:00Z';

function build(overrides: Partial<Parameters<typeof createReviewAssignment>[0]> = {}) {
  return createReviewAssignment({
    assignmentId: 'assignment-1',
    itemId: 'item-1',
    itemVersionId: 'version-1',
    subject: 'physics',
    reviewer: REVIEWER,
    kind: 'claimed',
    claimedAt: CLAIMED_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    ...overrides,
  });
}

describe('createReviewAssignment', () => {
  it('constructs a live assignment in the claimed state', () => {
    const assignment = expectValue(build());
    expect(assignment).toMatchObject({
      assignmentId: 'assignment-1',
      itemId: 'item-1',
      itemVersionId: 'version-1',
      subject: 'physics',
      kind: 'claimed',
      state: 'claimed',
      claimedAt: CLAIMED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    });
    expect(assignment.releasedAt).toBeUndefined();
    expect(assignment.decidedAt).toBeUndefined();
  });

  it.each(REVIEW_ASSIGNMENT_KINDS)('accepts kind "%s"', (kind) => {
    expectValue(build({ kind }));
  });

  it('refuses a blank assignmentId', () => {
    expect(expectError(build({ assignmentId: ' ' })).code).toBe('ASSIGNMENT_ID_REQUIRED');
  });

  it('refuses a blank itemId', () => {
    expect(expectError(build({ itemId: '' })).code).toBe('ITEM_ID_REQUIRED');
  });

  it('refuses a blank itemVersionId', () => {
    expect(expectError(build({ itemVersionId: '' })).code).toBe('ITEM_VERSION_ID_REQUIRED');
  });

  it('refuses a blank subject', () => {
    expect(expectError(build({ subject: '' })).code).toBe('SUBJECT_REQUIRED');
  });

  it('refuses a blank reviewer id', () => {
    expect(expectError(build({ reviewer: { ...REVIEWER, id: '' } })).code).toBe('REVIEWER_REQUIRED');
  });

  it('refuses an unknown reviewer kind', () => {
    expect(
      expectError(build({ reviewer: { ...REVIEWER, kind: 'robot' as never } })).code,
    ).toBe('REVIEWER_KIND_UNKNOWN');
  });

  it('refuses an unknown assignment kind', () => {
    expect(expectError(build({ kind: 'volunteered' as never })).code).toBe('KIND_UNKNOWN');
  });

  it('refuses a claimedAt that is not an ISO instant', () => {
    expect(expectError(build({ claimedAt: 'yesterday' })).code).toBe('CLAIMED_AT_NOT_A_TIMESTAMP');
  });

  it('refuses a leaseExpiresAt that is not an ISO instant', () => {
    expect(expectError(build({ leaseExpiresAt: 'later' })).code).toBe('LEASE_EXPIRES_AT_NOT_A_TIMESTAMP');
  });

  it('refuses a leaseExpiresAt at or before claimedAt', () => {
    expect(expectError(build({ leaseExpiresAt: CLAIMED_AT })).code).toBe('LEASE_BEFORE_CLAIM');
    expect(expectError(build({ leaseExpiresAt: '2026-08-19T09:00:00Z' })).code).toBe('LEASE_BEFORE_CLAIM');
  });
});

describe('transitionReviewAssignment — the exhaustive matrix', () => {
  const DECIDED_AT = '2026-08-19T11:00:00Z';

  // Every one of the sixteen (from, to) pairs over four states, asserted
  // against the table in review-assignment.ts rather than against a guess at
  // what it says — a table someone edits and a test someone doesn't both
  // change is exactly how a permitted transition goes silently missing.
  const ALLOWED: ReadonlySet<string> = new Set(['claimed->decided', 'claimed->released', 'claimed->expired']);

  it.each(REVIEW_ASSIGNMENT_STATES.flatMap((from) => REVIEW_ASSIGNMENT_STATES.map((to) => [from, to] as const)))(
    'from %s to %s',
    (from, to) => {
      const assignment: ReviewAssignment = { ...expectValue(build()), state: from };
      const result = transitionReviewAssignment(assignment, to, DECIDED_AT);
      const key = `${from}->${to}`;

      if (ALLOWED.has(key)) {
        const next = expectValue(result);
        expect(next.state).toBe(to);
      } else {
        expect(expectError(result).code).toBe('TRANSITION_NOT_PERMITTED');
        expect(expectError(result).message).toContain(from);
        expect(expectError(result).message).toContain(to);
      }
    },
  );

  it('stamps decidedAt on a transition to decided, and nothing else', () => {
    const assignment = expectValue(build());
    const next = expectValue(transitionReviewAssignment(assignment, 'decided', DECIDED_AT));
    expect(next.decidedAt).toBe(DECIDED_AT);
    expect(next.releasedAt).toBeUndefined();
  });

  it('stamps releasedAt on a transition to released, and nothing else', () => {
    const assignment = expectValue(build());
    const next = expectValue(transitionReviewAssignment(assignment, 'released', DECIDED_AT));
    expect(next.releasedAt).toBe(DECIDED_AT);
    expect(next.decidedAt).toBeUndefined();
  });

  it('stamps neither on a transition to expired', () => {
    const assignment = expectValue(build());
    const next = expectValue(transitionReviewAssignment(assignment, 'expired', DECIDED_AT));
    expect(next.decidedAt).toBeUndefined();
    expect(next.releasedAt).toBeUndefined();
  });

  it('refuses an "at" that is not an ISO instant, even on an otherwise-permitted transition', () => {
    const assignment = expectValue(build());
    expect(expectError(transitionReviewAssignment(assignment, 'decided', 'whenever')).code).toBe(
      'AT_NOT_A_TIMESTAMP',
    );
  });

  it('returns a new instance, leaving the original untouched', () => {
    const assignment = expectValue(build());
    const next = expectValue(transitionReviewAssignment(assignment, 'decided', DECIDED_AT));
    expect(assignment.state).toBe('claimed');
    expect(next).not.toBe(assignment);
  });
});

describe('isExpired — pure over a supplied instant', () => {
  it('is not expired before the lease expires', () => {
    const assignment = expectValue(build());
    expect(isExpired(assignment, '2026-08-19T13:59:59Z')).toBe(false);
  });

  it('is expired exactly at leaseExpiresAt (inclusive)', () => {
    const assignment = expectValue(build());
    expect(isExpired(assignment, LEASE_EXPIRES_AT)).toBe(true);
  });

  it('is expired after leaseExpiresAt', () => {
    const assignment = expectValue(build());
    expect(isExpired(assignment, '2026-08-19T14:00:01Z')).toBe(true);
  });
});

describe('assertClaimable — at most one live assignment per item version', () => {
  it('permits a claim when no assignment exists for the version', () => {
    expectValue(assertClaimable([], 'version-1'));
  });

  it('permits a claim when the only assignment for the version is no longer live', () => {
    const decided = { ...expectValue(build()), state: 'decided' as const };
    expectValue(assertClaimable([decided], 'version-1'));
  });

  it('refuses a second claim while one is live, as Conflict', () => {
    const live = expectValue(build());
    const result = assertClaimable([live], 'version-1');
    const error = expectError(result);
    expect(error.code).toBe('LIVE_ASSIGNMENT_EXISTS');
    expect(error.kind).toBe('Conflict');
  });

  it('does not conflict across different item versions', () => {
    const live = expectValue(build());
    expectValue(assertClaimable([live], 'version-2'));
  });
});

describe('immutability', () => {
  it('freezes the constructed assignment and its reviewer', () => {
    const assignment = expectValue(build());
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment.reviewer)).toBe(true);
    expect(Object.isFrozen(assignment.reviewer.roleContext)).toBe(true);
  });

  it('freezes the assignment produced by a transition', () => {
    const assignment = expectValue(build());
    const next = expectValue(transitionReviewAssignment(assignment, 'released', '2026-08-19T11:00:00Z'));
    expect(Object.isFrozen(next)).toBe(true);
  });
});
