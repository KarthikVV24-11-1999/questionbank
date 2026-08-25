/**
 * Not production code. Proves review plumbing importing
 * `infrastructure/transaction-runner.ts` is permitted (M4-28/M4-30) — the
 * third named shared-contract exception outside the domain layer.
 */
import { fakeClientOf } from '../../infrastructure/transaction-runner.js';

export const usesClientOf = fakeClientOf;
