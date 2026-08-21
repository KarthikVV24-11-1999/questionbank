/**
 * Not production code. Proves that adding `infrastructure/transaction-runner.ts`
 * as a permitted target did not widen into "all of `infrastructure/`" —
 * review plumbing reaching `infrastructure/item.repository.ts` must still
 * fail.
 */
import { fakeItemRepository } from '../../infrastructure/item.repository.js';

export const smuggledRepository = fakeItemRepository;
