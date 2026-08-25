/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` exempts the
 * composition seam (`public/composition.ts`) in both directions — it wires
 * every layer, review's own handlers included, into the composed module, so
 * "authoring reaches review" is not a violation here but the seam's job.
 */
import { smuggled } from '../application/review/planted-reaches-authoring.js';

export const wired = smuggled;
