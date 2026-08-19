/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` permits the
 * one named exception outside the domain layer: `application/authorization.ts`.
 */
import { fakeAuthorization } from '../application/authorization.js';

export const usesAuthorization = fakeAuthorization;
