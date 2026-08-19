/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` catches
 * review plumbing (`application/review/`) reaching into content's authoring
 * plumbing for something that is neither a domain module nor
 * `application/authorization.ts`.
 */
import { fakeHandler } from '../authoring-handler.js';

export const smuggled = fakeHandler;
