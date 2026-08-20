import { describe, expect, it } from 'vitest';
import { AUTHOR, REVIEWER } from '../../../../testing/content-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import {
  DUPLICATE_DISCLOSURE_STATES,
  assertDecisionEvidenceComplete,
  duplicateDisclosureState,
  type DecisionEvidenceInput,
} from './decision-evidence.js';

const VERSION = { authoredBy: AUTHOR };

function input(overrides: Partial<DecisionEvidenceInput> = {}): DecisionEvidenceInput {
  return {
    outcome: 'approve',
    reviewer: REVIEWER,
    candidatesShownIds: [],
    ...overrides,
  };
}

describe('duplicateDisclosureState', () => {
  it('is not_evaluated when candidatesShownIds is absent', () => {
    expect(duplicateDisclosureState(undefined)).toBe('not_evaluated');
  });

  it('is none_found when candidatesShownIds is empty', () => {
    expect(duplicateDisclosureState([])).toBe('none_found');
  });

  it('is candidates_found when candidatesShownIds is non-empty', () => {
    expect(duplicateDisclosureState(['item-1'])).toBe('candidates_found');
  });

  it('never collapses absent and empty to the same value', () => {
    expect(duplicateDisclosureState(undefined)).not.toBe(duplicateDisclosureState([]));
  });

  it('mirrors pre-submission-validation.ts’s DuplicateCheckState vocabulary exactly', () => {
    expect(DUPLICATE_DISCLOSURE_STATES).toEqual(['not_evaluated', 'none_found', 'candidates_found']);
  });
});

describe('assertDecisionEvidenceComplete', () => {
  it('permits an approving decision with an empty candidate list and no reason', () => {
    expectValue(assertDecisionEvidenceComplete(input(), VERSION));
  });

  it('refuses self-review before any other check — the author reviewing their own version', () => {
    const error = expectError(assertDecisionEvidenceComplete(input({ reviewer: AUTHOR }), VERSION));
    expect(error.code).toBe('SELF_REVIEW_PROHIBITED');
  });

  it('refuses self-review by the editor', () => {
    const error = expectError(
      assertDecisionEvidenceComplete(input({ reviewer: REVIEWER }), { authoredBy: AUTHOR, editedBy: REVIEWER }),
    );
    expect(error.code).toBe('SELF_REVIEW_PROHIBITED');
  });

  it('refuses a missing candidatesShownIds, on an approving outcome too', () => {
    const error = expectError(
      assertDecisionEvidenceComplete({ outcome: 'approve', reviewer: REVIEWER }, VERSION),
    );
    expect(error.code).toBe('CANDIDATES_SHOWN_REQUIRED');
  });

  it.each(['request_changes', 'reject'] as const)(
    'refuses a %s decision with no reasonCode',
    (outcome) => {
      const error = expectError(assertDecisionEvidenceComplete(input({ outcome }), VERSION));
      expect(error.code).toBe('REASON_CODE_REQUIRED');
    },
  );

  it('refuses a blank reasonCode', () => {
    const error = expectError(
      assertDecisionEvidenceComplete(input({ outcome: 'reject', reasonCode: '   ' }), VERSION),
    );
    expect(error.code).toBe('REASON_CODE_REQUIRED');
  });

  it('refuses a reasonCode not eligible for the outcome', () => {
    const error = expectError(
      assertDecisionEvidenceComplete(
        input({ outcome: 'request_changes', reasonCode: 'DUPLICATE' }),
        VERSION,
      ),
    );
    expect(error.code).toBe('REASON_NOT_ELIGIBLE_FOR_OUTCOME');
  });

  it('refuses DUPLICATE with no duplicateOfItemId', () => {
    const error = expectError(
      assertDecisionEvidenceComplete(input({ outcome: 'reject', reasonCode: 'DUPLICATE' }), VERSION),
    );
    expect(error.code).toBe('DUPLICATE_REQUIRES_A_TARGET');
  });

  it('permits DUPLICATE with a duplicateOfItemId', () => {
    expectValue(
      assertDecisionEvidenceComplete(
        input({ outcome: 'reject', reasonCode: 'DUPLICATE', duplicateOfItemId: 'item-9' }),
        VERSION,
      ),
    );
  });

  it('permits a well-formed request_changes decision with a non-duplicate reason', () => {
    expectValue(
      assertDecisionEvidenceComplete(
        input({ outcome: 'request_changes', reasonCode: 'AMBIGUOUS_STEM', candidatesShownIds: ['item-4'] }),
        VERSION,
      ),
    );
  });

  it('permits approve_with_edits the same as approve — no reason required', () => {
    expectValue(assertDecisionEvidenceComplete(input({ outcome: 'approve_with_edits' }), VERSION));
  });
});
