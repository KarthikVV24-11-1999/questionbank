import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AI_AGENT, AUTHOR, AUTHORED_AT, REVIEWER } from '../../../testing/content-fixtures.js';
import {
  createReviewDecision,
  isApproving,
  REVIEW_OUTCOMES,
  REVIEWED_OWNER_TYPES,
  toReviewerSignature,
  type CreateReviewDecisionProps,
} from './review-decision.js';

function props(overrides: Partial<CreateReviewDecisionProps> = {}): CreateReviewDecisionProps {
  return {
    decisionId: 'decision-1',
    ownerType: 'item_version',
    ownerVersionId: 'version-1',
    reviewer: REVIEWER,
    outcome: 'approve',
    decidedAt: AUTHORED_AT,
    ...overrides,
  };
}

describe('construction', () => {
  it('builds an approving decision', () => {
    const decision = expectValue(createReviewDecision(props()));
    expect(decision).toMatchObject({
      decisionId: 'decision-1',
      ownerType: 'item_version',
      ownerVersionId: 'version-1',
      outcome: 'approve',
      decidedAt: AUTHORED_AT,
    });
    expect(decision.reviewer.id).toBe(REVIEWER.id);
  });

  it.each(REVIEWED_OWNER_TYPES)('accepts %s as a reviewed owner', (ownerType) => {
    expect(expectValue(createReviewDecision(props({ ownerType }))).ownerType).toBe(ownerType);
  });

  it('omits an absent justification rather than storing undefined', () => {
    expect(expectValue(createReviewDecision(props()))).not.toHaveProperty('justification');
  });

  it('is frozen, reviewer roles included', () => {
    const decision = expectValue(createReviewDecision(props()));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reviewer.roleContext)).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a blank decision id', () => {
    expect(expectError(createReviewDecision(props({ decisionId: '  ' }))).code).toBe('DECISION_ID_REQUIRED');
  });

  it('refuses an unknown owner type', () => {
    expect(expectError(createReviewDecision(props({ ownerType: 'form' as never }))).code).toBe(
      'OWNER_TYPE_UNKNOWN',
    );
  });

  it('refuses a decision naming no version', () => {
    const failure = expectError(createReviewDecision(props({ ownerVersionId: '   ' })));
    expect(failure.code).toBe('OWNER_VERSION_REQUIRED');
    expect(failure.location).toBe('reviewDecision.ownerVersionId');
  });

  it('refuses a decision with no reviewer (INV-02)', () => {
    expect(
      expectError(createReviewDecision(props({ reviewer: { ...REVIEWER, id: '  ' } }))).code,
    ).toBe('REVIEWER_REQUIRED');
  });

  it('refuses an unknown outcome rather than coercing it', () => {
    expect(expectError(createReviewDecision(props({ outcome: 'maybe' as never }))).code).toBe(
      'OUTCOME_UNKNOWN',
    );
  });

  // An author told only "rejected" has nothing to act on.
  it.each(['request_changes', 'reject'] as const)('refuses %s with no justification', (outcome) => {
    expect(expectError(createReviewDecision(props({ outcome }))).code).toBe('JUSTIFICATION_REQUIRED');
    expect(expectError(createReviewDecision(props({ outcome, justification: '   ' }))).code).toBe(
      'JUSTIFICATION_REQUIRED',
    );
    expect(
      expectValue(createReviewDecision(props({ outcome, justification: 'the stem is ambiguous' }))).outcome,
    ).toBe(outcome);
  });

  it('refuses a decidedAt that is not an instant', () => {
    expect(expectError(createReviewDecision(props({ decidedAt: 'yesterday' }))).code).toBe(
      'DECIDED_AT_NOT_A_TIMESTAMP',
    );
  });
});

describe('the signature it produces', () => {
  it.each(['approve', 'approve_with_edits'] as const)('%s yields a signature for that version', (outcome) => {
    const signature = toReviewerSignature(expectValue(createReviewDecision(props({ outcome }))));
    expect(signature).toMatchObject({ itemVersionId: 'version-1', decision: outcome, signedAt: AUTHORED_AT });
    expect(signature?.reviewer.id).toBe(REVIEWER.id);
  });

  // A decision that sent work back is not a signature, and returning one
  // anyway would let a rejected version publish.
  it.each(['request_changes', 'reject'] as const)('%s yields nothing', (outcome) => {
    const decision = expectValue(createReviewDecision(props({ outcome, justification: 'needs work' })));
    expect(toReviewerSignature(decision)).toBeUndefined();
  });

  it('carries a machine reviewer through unchanged, for INV-01 to refuse later', () => {
    const decision = expectValue(createReviewDecision(props({ reviewer: AI_AGENT })));
    expect(toReviewerSignature(decision)?.reviewer.kind).toBe('ai_agent');
  });

  it('names an author who reviewed their own work, for INV-12 to refuse later', () => {
    const decision = expectValue(createReviewDecision(props({ reviewer: AUTHOR })));
    expect(toReviewerSignature(decision)?.reviewer.id).toBe(AUTHOR.id);
  });
});

describe('the outcome vocabulary', () => {
  it('is closed and exactly four', () => {
    expect(REVIEW_OUTCOMES).toEqual(['approve', 'approve_with_edits', 'request_changes', 'reject']);
  });

  it.each([
    ['approve', true],
    ['approve_with_edits', true],
    ['request_changes', false],
    ['reject', false],
  ] as const)('reports %s as approving=%s', (outcome, expected) => {
    expect(isApproving(outcome)).toBe(expected);
  });
});
