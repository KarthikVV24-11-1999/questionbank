/**
 * The review workspace's HTTP surface (DEC-M4-7, DEC-M4-12).
 *
 * Mounts under `/v1/authoring/review/**` — the enumerated, key-bearing prefix
 * ADR-0009 already closes over `/v1/authoring/**`, so a review screen showing
 * an answer key needs no amendment to that enumeration.
 *
 * Empty until the application layer it calls exists (M4-27 onward); not
 * registered on `content.module.ts` until then. Its file lives here now so
 * the intra-context sub-boundary (M4-01) has a real `api/review.controller.ts`
 * to enforce against, rather than a rule with nothing to check.
 */
export class ReviewController {}
