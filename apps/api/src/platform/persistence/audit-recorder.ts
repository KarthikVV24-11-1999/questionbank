import type { Pool } from 'pg';
import type { PrincipalKind, RoleSet, UserId } from '@questionbank/domain-types';

/**
 * Content, curriculum and scoring each declare their own `AuditRecord` and
 * `AuditRecorder` independently, and each has said since its own milestone
 * "D4 replaces the in-memory implementation with a durable one." This is
 * that durable implementation — **one adapter serving all three
 * declarations**, writing to the single `platform.audit_record` table
 * `20260813120000_platform_audit.sql` creates.
 *
 * The shapes are not identical: curriculum's carries `targetVersion`,
 * content's alone carries `justification`, and each fixes `targetContext` to
 * its own literal. `AuditRecordLike` below is the structural superset that
 * every context's own interface is assignable to — this class is typed
 * against it and never against any one context's declaration, so it never
 * imports from a context's application layer (§9 rule 1 holds even though
 * `platform/` is infrastructure, not a bounded context: the alternative is
 * three copies of an INSERT statement instead of one).
 */
export interface AuditRecordLike {
  readonly principal: {
    readonly kind: PrincipalKind;
    readonly id: UserId;
    readonly roleContext: RoleSet;
  };
  readonly action: string;
  readonly targetContext: 'content' | 'curriculum' | 'scoring';
  readonly targetType: string;
  readonly targetId: string;
  readonly targetVersion?: number;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly justification?: string;
}

export interface AuditRecorderLike {
  record(entry: AuditRecordLike): Promise<void>;
}

export class PostgresAuditRecorder implements AuditRecorderLike {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(entry: AuditRecordLike): Promise<void> {
    await this.#pool.query(
      `INSERT INTO platform.audit_record
         (principal_kind, principal_id, action, target_context, target_type, target_id,
          target_version, correlation_id, occurred_at, justification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.principal.kind,
        entry.principal.id,
        entry.action,
        entry.targetContext,
        entry.targetType,
        entry.targetId,
        entry.targetVersion ?? null,
        entry.correlationId,
        entry.occurredAt,
        entry.justification ?? null,
      ],
    );
  }
}
