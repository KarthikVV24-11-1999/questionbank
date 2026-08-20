/**
 * Stands in for a domain aggregate that happens to live under `domain/review/`
 * — `ReviewAssignment`, `self-review.ts`. F2 already keeps it pure; this gate
 * must not additionally wall it off from content's authoring-side domain
 * (M4-04's `publication-preconditions.ts` importing `isSelfReview` is exactly
 * this shape).
 */
export const fakeReviewAggregate = 'review-aggregate';
