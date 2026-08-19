import { err, ok, type Result } from '../result.js';
import { ruleViolationError, type ContentError } from '../content-error.js';

/**
 * The approve-with-edits edit scope (DEC-M4-3) — the bound that separates
 * "the reviewer edited it" from "the reviewer wrote it".
 *
 * **The vocabulary spans two aggregates on purpose.** `stem`, `taxonomyTags`
 * and `difficultyEstimate` are `ItemVersion`'s own fields; `solutionProse`
 * names the prose inside a `SolutionVersion`'s steps, and `textAlternative`
 * names the accessibility string on a notation node nested inside `stem`'s
 * `ContentBody` (ACC-02). A reviewer editing under this outcome touches both
 * aggregates in one session, so the closed vocabulary names what changed by
 * concept, not by which object happens to own the field — `diffWithinScope`
 * takes the field names a caller identifies as changed, not two whole
 * `ItemVersion`s to diff structurally.
 *
 * **Exhaustiveness is checked against `ItemVersion`'s real shape, not just
 * this module's own two lists.** Three of `ItemVersion`'s twelve fields
 * appear in `FORBIDDEN_UNDER_REVIEW` (`responseSpec`, `itemType`,
 * `provenance`); three appear in `EDITABLE_UNDER_REVIEW` (`stem`,
 * `taxonomyTags`, `difficultyEstimate`); the remaining six —
 * `versionId`, `versionNo`, `authoredBy`, `createdAt`, `licensing`,
 * `stimulusVersionRef` — are neither, and `ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE`
 * names them with why: the first four are assigned by the version-derivation
 * mechanism itself, never by a reviewer's decision; `licensing` and
 * `stimulusVersionRef` are governed by their own dedicated commands
 * (relicensing, stimulus attachment), not by approve-with-edits. Every field
 * `ItemVersion` has is accounted for by exactly one of the three lists —
 * `edit-scope.spec.ts` asserts it directly against a real constructed
 * version, and red against a field added to none of them.
 */

export const EDITABLE_UNDER_REVIEW = ['stem', 'solutionProse', 'textAlternative', 'taxonomyTags', 'difficultyEstimate'] as const;
export type EditableUnderReviewField = (typeof EDITABLE_UNDER_REVIEW)[number];

export const FORBIDDEN_UNDER_REVIEW = ['responseSpec', 'itemType', 'provenance'] as const;
export type ForbiddenUnderReviewField = (typeof FORBIDDEN_UNDER_REVIEW)[number];

/**
 * `ItemVersion` fields that are neither editable nor forbidden under review
 * because they are simply never the subject of an approve-with-edits diff —
 * assigned by the derivation mechanism, or owned by a different command
 * entirely. Named here, with why, so `edit-scope.spec.ts`'s exhaustiveness
 * check has a real answer for every field rather than a silent gap.
 */
export const ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE = [
  'versionId',
  'versionNo',
  'authoredBy',
  'createdAt',
  'licensing',
  'stimulusVersionRef',
] as const;

export type EditScopeErrorCode = 'EDIT_EXCEEDS_REVIEW_SCOPE' | 'KEY_EDIT_REQUIRES_CHANGES_REQUESTED';
export type EditScopeError = ContentError<EditScopeErrorCode>;

/** `responseSpec` is the key: refusing it names the outcome a reviewer should use instead, not just "no". */
const KEY_FIELD: EditableUnderReviewField | ForbiddenUnderReviewField = 'responseSpec';

function isEditable(field: string): field is EditableUnderReviewField {
  return (EDITABLE_UNDER_REVIEW as readonly string[]).includes(field);
}

/**
 * Refuses the first field outside `EDITABLE_UNDER_REVIEW`, naming it. An
 * empty list of changed fields is permitted and reported back as empty — no
 * edit at all is not a scope violation.
 */
export function diffWithinScope(
  changedFields: readonly string[],
  location = 'edit',
): Result<readonly string[], EditScopeError> {
  for (const field of changedFields) {
    if (field === KEY_FIELD) {
      return err(
        ruleViolationError(
          'KEY_EDIT_REQUIRES_CHANGES_REQUESTED',
          `a change to "${field}" is not an edit — it changes the key; use request_changes instead of approve_with_edits`,
          `${location}.${field}`,
        ),
      );
    }
    if (!isEditable(field)) {
      return err(
        ruleViolationError(
          'EDIT_EXCEEDS_REVIEW_SCOPE',
          `"${field}" is outside the approve-with-edits scope`,
          `${location}.${field}`,
        ),
      );
    }
  }
  return ok(changedFields);
}
