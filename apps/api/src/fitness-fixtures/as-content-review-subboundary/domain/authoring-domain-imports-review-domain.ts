/**
 * Not production code. Proves an authoring-side domain module (the shape of
 * `publication-preconditions.ts`) importing a `domain/review/` aggregate
 * (the shape of `self-review.ts`) is **permitted** — F2 already keeps both
 * pure; this gate does not additionally wall them off from each other
 * (M4-04).
 */
import { fakeReviewAggregate } from './review/fake-review-aggregate.js';

export const usesReviewDomain = fakeReviewAggregate;
