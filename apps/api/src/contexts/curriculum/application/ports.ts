import type { PrincipalRef } from '@questionbank/domain-types';
import type { AuthorizationContext } from './authorization.js';

/** What every handler is given besides its command. */
export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/**
 * One row per consequential command (DATA-ARCHITECTURE P3). The durable
 * implementation writes to `identity.audit_record`, which arrives with the
 * identity schema; the port is what the curriculum context depends on.
 */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'curriculum';
  readonly targetType: string;
  readonly targetId: string;
  readonly targetVersion?: number;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/** Time and identity are injected so handlers stay deterministic under test. */
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
