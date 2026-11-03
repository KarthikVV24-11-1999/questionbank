import type { Pool } from 'pg';
import { PostgresUserStore } from '../contexts/identity/infrastructure/postgres-stores.js';
import type { AuditFor, AuditRecord } from '../contexts/identity/application/ports.js';
import type { StoredCredential } from '../contexts/identity/domain/password-hash.js';
import type { User } from '../contexts/identity/domain/user.js';
import { PostgresAuditRecorder } from '../platform/persistence/audit-recorder.js';

/**
 * People for tests that need someone to exist (M8-14). Registering is audited with the user in one transaction, so seeding a user takes an audit row too; this makes it the same row
 * the application would write, from a principal that is nobody's.
 */
const SEEDER = Object.freeze({ kind: 'system' as const, id: '00000000-0000-4000-8000-0000000000e5', roleContext: Object.freeze(['system']) });

export const auditFor = (action: string, correlationId = 'test'): AuditFor => (userId) => ({ principal: SEEDER, action, targetContext: 'identity', targetType: 'User', targetId: userId, correlationId, occurredAt: new Date('2026-11-03T09:00:00.000Z') });

export const seedAudit = (userId: string): AuditRecord => auditFor('UserRegistered')(userId);

export async function seedPerson(pool: Pool, user: User, credential: StoredCredential): Promise<boolean> {
  return new PostgresUserStore(pool, new PostgresAuditRecorder(pool)).create(user, credential, seedAudit(user.userId));
}
