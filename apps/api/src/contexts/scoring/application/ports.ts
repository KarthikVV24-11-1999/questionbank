import type { PrincipalRef } from '@questionbank/domain-types';
import type { AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/** One row per consequential command (DATA-ARCHITECTURE P3). D4 replaces the in-memory one. */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'scoring';
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/**
 * The clock lives here, not in the domain. §3 requires the scoring function to
 * be pure and F45 checks it, so `computedAt` is read once at the boundary and
 * passed in.
 */
export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

export class InMemoryAuditRecorder implements AuditRecorder {
  readonly entries: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }

  entriesFor(targetId: string): readonly AuditRecord[] {
    return this.entries.filter((entry) => entry.targetId === targetId);
  }
}
