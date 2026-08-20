/**
 * Not production code. Proves review plumbing importing a domain-root
 * aggregate/value object is permitted.
 */
import { fakeAggregate } from '../../domain/fake-aggregate.js';

export const usesDomain = fakeAggregate;
