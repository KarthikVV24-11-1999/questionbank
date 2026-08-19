/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` catches the
 * other direction — an authoring-side module reaching into `review/`, which
 * DEC-M4-7's sub-boundary forbids absolutely.
 */
import { smuggled } from '../review/planted-reaches-authoring.js';

export const reachesReview = smuggled;
