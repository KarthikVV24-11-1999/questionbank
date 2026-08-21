/**
 * Not production code. Proves that adding `application/ports.ts` as a
 * permitted target did not widen into "all of `application/`" — review
 * plumbing reaching `application/queries/authoring-queries.ts` must still
 * fail.
 */
import { fakeListSubmittedForReview } from '../queries/authoring-queries.js';

export const smuggledQuery = fakeListSubmittedForReview;
