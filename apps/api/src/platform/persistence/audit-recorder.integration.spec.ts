import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { PostgresAuditRecorder, type AuditRecordLike } from './audit-recorder.js';

/**
 * Proven against real Postgres, not a mock (Handbook §9 rule 9). The
 * append-only trigger is proven with raw SQL, on the same argument
 * `scoring-immutability.integration.spec.ts` makes: a rule the ORM happens
 * to respect is a convention, one the database enforces is an invariant.
 */
let database: TestDatabase;
let recorder: PostgresAuditRecorder;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  recorder = new PostgresAuditRecorder(database.pool);
});

afterEach(async () => {
  await database.pool.query('TRUNCATE platform.audit_record');
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

async function rejectionMessage(text: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(text, [...params]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(the statement succeeded)';
}

const CONTENT_ENTRY: AuditRecordLike = {
  principal: { kind: 'human', id: 'user-1', roleContext: ['author'] },
  action: 'item.publish',
  targetContext: 'content',
  targetType: 'ItemVersion',
  targetId: 'item-version-1',
  correlationId: 'corr-1',
  occurredAt: new Date('2026-08-13T10:00:00.000Z'),
  justification: 'scheduled release',
};

describe('PostgresAuditRecorder — an audit record round-trips', () => {
  it('writes exactly what was recorded, readable back by raw SQL', async () => {
    await recorder.record(CONTENT_ENTRY);

    const { rows } = await database.pool.query<Record<string, unknown>>(
      'SELECT * FROM platform.audit_record WHERE target_id = $1',
      [CONTENT_ENTRY.targetId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row['principal_kind']).toBe('human');
    expect(row['principal_id']).toBe('user-1');
    expect(row['action']).toBe('item.publish');
    expect(row['target_context']).toBe('content');
    expect(row['target_type']).toBe('ItemVersion');
    expect(row['target_id']).toBe('item-version-1');
    expect(row['target_version']).toBeNull();
    expect(row['correlation_id']).toBe('corr-1');
    expect(row['justification']).toBe('scheduled release');
    expect(new Date(row['occurred_at'] as string).toISOString()).toBe(CONTENT_ENTRY.occurredAt.toISOString());
  });

  it('round-trips curriculum\'s shape, which carries targetVersion and no justification', async () => {
    const entry: AuditRecordLike = {
      principal: { kind: 'ai_agent', id: 'agent-1', roleContext: ['content_generator'] },
      action: 'taxonomy.migrate',
      targetContext: 'curriculum',
      targetType: 'TaxonomyVersion',
      targetId: 'taxonomy-version-1',
      targetVersion: 3,
      correlationId: 'corr-2',
      occurredAt: new Date('2026-08-13T11:00:00.000Z'),
    };
    await recorder.record(entry);

    const { rows } = await database.pool.query<Record<string, unknown>>(
      'SELECT * FROM platform.audit_record WHERE target_id = $1',
      [entry.targetId],
    );
    const row = rows[0] as Record<string, unknown>;
    expect(row['principal_kind']).toBe('ai_agent');
    expect(row['target_context']).toBe('curriculum');
    expect(row['target_version']).toBe(3);
    expect(row['justification']).toBeNull();
  });

  it('round-trips scoring\'s shape', async () => {
    const entry: AuditRecordLike = {
      principal: { kind: 'system', id: 'system-rescorer', roleContext: [] },
      action: 'score.rescore',
      targetContext: 'scoring',
      targetType: 'ScoreRecord',
      targetId: 'score-record-1',
      correlationId: 'corr-3',
      occurredAt: new Date('2026-08-13T12:00:00.000Z'),
    };
    await recorder.record(entry);

    const { rows } = await database.pool.query<Record<string, unknown>>(
      'SELECT * FROM platform.audit_record WHERE target_id = $1',
      [entry.targetId],
    );
    expect(rows[0]?.['target_context']).toBe('scoring');
  });
});

describe('platform.audit_record — append-only under raw SQL', () => {
  it('rejects an update', async () => {
    await recorder.record(CONTENT_ENTRY);
    const message = await rejectionMessage(
      `UPDATE platform.audit_record SET action = 'tampered' WHERE target_id = $1`,
      [CONTENT_ENTRY.targetId],
    );
    expect(message).toContain('audit_record_is_append_only');
  });

  it('rejects a delete', async () => {
    await recorder.record(CONTENT_ENTRY);
    const message = await rejectionMessage('DELETE FROM platform.audit_record WHERE target_id = $1', [
      CONTENT_ENTRY.targetId,
    ]);
    expect(message).toContain('audit_record_is_append_only');
  });

  it('rejects an unknown principal_kind at the constraint, never coerced', async () => {
    const message = await rejectionMessage(
      `INSERT INTO platform.audit_record
         (principal_kind, principal_id, action, target_context, target_type, target_id, correlation_id, occurred_at)
       VALUES ('moderator', 'user-1', 'x', 'content', 'ItemVersion', 'iv-1', 'corr-1', now())`,
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toBe('(the statement succeeded)');
  });

  it('rejects an unknown target_context', async () => {
    const message = await rejectionMessage(
      `INSERT INTO platform.audit_record
         (principal_kind, principal_id, action, target_context, target_type, target_id, correlation_id, occurred_at)
       VALUES ('human', 'user-1', 'x', 'billing', 'ItemVersion', 'iv-1', 'corr-1', now())`,
    );
    expect(message).not.toBe('(the statement succeeded)');
  });
});
