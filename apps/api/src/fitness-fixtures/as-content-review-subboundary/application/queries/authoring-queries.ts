/**
 * Stands in for the real `application/queries/authoring-queries.ts` —
 * authoring-specific application plumbing, not one of the three permitted
 * targets. Proves the M4-27 exemption stayed narrow: this file is not
 * `application/ports.ts`, so review plumbing reaching it must still fail.
 */
export const fakeListSubmittedForReview = 'authoring-queries';
