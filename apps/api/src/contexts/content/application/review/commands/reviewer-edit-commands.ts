import type { ReviewerEdits } from '../../../domain/item-version.js';

export interface ApproveWithEdits {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly edits: ReviewerEdits;
  /**
   * Required and may be empty (M4-07, DEC-M4-2) — absent-vs-empty is the
   * distinction `assertDecisionEvidenceComplete` keeps from collapsing.
   */
  readonly candidatesShownIds: readonly string[];
  /** The claimed assignment this edit resolves (M4-18/M4-27); optional, same fallback `ReviewDecisionRepository.record` documents. */
  readonly assignmentId?: string;
}
