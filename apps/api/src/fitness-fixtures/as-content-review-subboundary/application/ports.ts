/**
 * Stands in for `application/ports.ts` — the second named exception outside
 * the domain layer that the review plumbing may import (M4-27): a
 * context-wide structural contract (Clock, AuditRecorder, IdentifierFactory,
 * ApplicationContext), specific to neither side.
 */
export const fakePorts = 'ports';
