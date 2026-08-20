/**
 * Not production code. Proves review plumbing importing
 * `application/authorization.ts` is permitted — the one named exception.
 */
import { fakeAuthorization } from '../authorization.js';

export const usesAuthorization = fakeAuthorization;
