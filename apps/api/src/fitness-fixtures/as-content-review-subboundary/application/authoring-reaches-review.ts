/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` catches the
 * other direction — authoring plumbing reaching into review plumbing
 * (`application/review/`), which DEC-M4-7's sub-boundary forbids absolutely.
 */
import { smuggled } from './review/planted-reaches-authoring.js';

export const reachesReview = smuggled;
