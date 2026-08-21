/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` permits
 * review plumbing to import the composition root the other way too — the
 * exemption is stated as both-directions, not only "composition may reach
 * review".
 */
import { wired } from '../../public/composition.js';

export const reused = wired;
