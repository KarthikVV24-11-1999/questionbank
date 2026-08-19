/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` does not flag
 * the imports it is supposed to permit — a domain aggregate/value object.
 */
import { fakeAggregate } from '../domain/fake-aggregate.js';

export const usesDomain = fakeAggregate;
