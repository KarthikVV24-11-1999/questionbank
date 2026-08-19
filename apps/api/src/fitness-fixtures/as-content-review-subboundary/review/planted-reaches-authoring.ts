/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` catches a
 * `review/` module reaching into content's authoring side for something that
 * is neither a domain aggregate/value object nor `application/authorization.ts`.
 */
import { fakeHandler } from '../authoring/fake-handler.js';

export const smuggled = fakeHandler;
