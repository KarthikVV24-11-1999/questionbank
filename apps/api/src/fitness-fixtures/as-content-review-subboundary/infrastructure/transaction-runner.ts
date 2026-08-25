/**
 * Stands in for `infrastructure/transaction-runner.ts` — the third named
 * shared-contract exception outside the domain layer (M4-28/M4-30):
 * `TransactionContext`'s one concrete implementation and its downcast,
 * `clientOf`, used by repositories on both sides to join a caller's shared
 * transaction.
 */
export const fakeClientOf = 'clientOf';
