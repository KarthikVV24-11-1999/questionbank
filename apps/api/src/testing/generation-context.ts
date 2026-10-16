import type { PrincipalRef } from '@questionbank/domain-types';
import type { ApplicationContext, AuditRecord, AuditRecorder, Clock, IdentifierFactory } from '../contexts/generation/application/ports.js';
import { randomUUID } from 'node:crypto';

/** A principal holding exactly `roles`. */
export function principalWith(roles: readonly string[], kind: PrincipalRef['kind'] = 'human'): PrincipalRef {
  return { id: randomUUID(), kind, roleContext: [...roles] } as PrincipalRef;
}

export function contextFor(principal: PrincipalRef, correlationId = `corr-${randomUUID()}`): ApplicationContext {
  return { principal, correlationId };
}

export class RecordingAudit implements AuditRecorder {
  readonly entries: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }
}

export const FIXED_NOW = new Date('2026-10-16T09:30:00.000Z');
export const fixedClock: Clock = { now: () => FIXED_NOW };
export const uuidFactory: IdentifierFactory = { next: () => randomUUID() };
