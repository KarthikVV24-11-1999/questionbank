import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import type { ItemReviewEscalated } from '../../domain/events/content-events.js';
import { PostgresReviewEscalationRepository } from './review-escalation.repository.js';
import { PostgresTransactionRunner } from '../transaction-runner.js';

let database: TestDatabase;
let repository: PostgresReviewEscalationRepository;
let runner: PostgresTransactionRunner;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresReviewEscalationRepository(database.pool);
  runner = new PostgresTransactionRunner(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-c000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();

async function seedInReviewItemVersion(subject = 'physics'): Promise<{ itemId: string; itemVersionId: string }> {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  await database.pool.query(
    `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', $2)`,
    [itemId, subject],
  );
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
    [itemVersionId, itemId, AUTHOR_ID],
  );
  return { itemId, itemVersionId };
}

function eventFor(itemId: string, itemVersionId: string, subject = 'physics'): ItemReviewEscalated {
  return {
    eventId: freshUuid(),
    eventType: 'ItemReviewEscalated',
    schemaVersion: 1,
    occurredAt: new Date('2026-08-21T09:00:00.000Z'),
    principal: { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] },
    correlationId: 'corr-1',
    payload: { itemId, itemVersionId, subject, targetRoleType: 'content_ops' },
  };
}

describe('escalateIfNew — the escalation row and its event, together (M4-31)', () => {
  it('writes the row and the outbox event, and returns true', async () => {
    const { itemId, itemVersionId } = await seedInReviewItemVersion();
    const event = eventFor(itemId, itemVersionId);

    const result = await runner.run((tx) =>
      repository.escalateIfNew(
        { itemId, itemVersionId, subject: 'physics', reason: 'past the 72h threshold', escalatedAt: '2026-08-21T09:00:00.000Z' },
        event,
        tx,
      ),
    );
    expect(expectValue(result)).toBe(true);

    const row = await database.pool.query<{ target_role: string; reason: string }>(
      `SELECT target_role, reason FROM content.review_escalation WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.target_role).toBe('content_ops');
    expect(row.rows[0]!.reason).toBe('past the 72h threshold');

    // Matches the shape ContentOutboxEmitter itself would have written for
    // the same event — the one place the inlined insert and the shared
    // emitter must agree (aggregate_type is hardcoded to 'Item' here).
    const outboxed = await database.pool.query<{
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
      principal_id: string;
      correlation_id: string;
    }>(`SELECT event_type, aggregate_type, aggregate_id, payload, principal_id, correlation_id FROM platform.outbox_message WHERE aggregate_id = $1 AND event_type = 'ItemReviewEscalated'`, [
      itemId,
    ]);
    expect(outboxed.rowCount).toBe(1);
    expect(outboxed.rows[0]!.aggregate_type).toBe('Item');
    expect(outboxed.rows[0]!.principal_id).toBe(event.principal.id);
    expect(outboxed.rows[0]!.correlation_id).toBe('corr-1');
    expect(outboxed.rows[0]!.payload).toEqual(event.payload);
  });

  it('is idempotent: a second call for the same item version writes nothing and returns false', async () => {
    const { itemId, itemVersionId } = await seedInReviewItemVersion();
    const criteria = { itemId, itemVersionId, subject: 'physics', reason: 'r', escalatedAt: '2026-08-21T09:00:00.000Z' };

    const first = await runner.run((tx) => repository.escalateIfNew(criteria, eventFor(itemId, itemVersionId), tx));
    expect(expectValue(first)).toBe(true);

    const second = await runner.run((tx) => repository.escalateIfNew(criteria, eventFor(itemId, itemVersionId), tx));
    expect(expectValue(second)).toBe(false);

    const rows = await database.pool.query(`SELECT 1 FROM content.review_escalation WHERE item_version_id = $1`, [
      itemVersionId,
    ]);
    expect(rows.rowCount).toBe(1);

    const outboxed = await database.pool.query(
      `SELECT 1 FROM platform.outbox_message WHERE aggregate_id = $1 AND event_type = 'ItemReviewEscalated'`,
      [itemId],
    );
    expect(outboxed.rowCount).toBe(1);
  });

  it('reports a malformed write as PERSISTENCE_REJECTED, not thrown', async () => {
    const result = await runner.run((tx) =>
      repository.escalateIfNew(
        { itemId: 'not-a-uuid', itemVersionId: 'also-not-a-uuid', subject: 'physics', reason: 'r', escalatedAt: '2026-08-21T09:00:00.000Z' },
        eventFor('not-a-uuid', 'also-not-a-uuid'),
        tx,
      ),
    );
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('findNotifiedAt — the Tier-3-dependent notification read (M4-33)', () => {
  it('maps only the item versions that were actually escalated', async () => {
    const { itemId, itemVersionId } = await seedInReviewItemVersion();
    const { itemVersionId: neverEscalated } = await seedInReviewItemVersion();
    await runner.run((tx) =>
      repository.escalateIfNew(
        { itemId, itemVersionId, subject: 'physics', reason: 'r', escalatedAt: '2026-08-21T09:00:00.000Z' },
        eventFor(itemId, itemVersionId),
        tx,
      ),
    );

    const found = expectValue(await repository.findNotifiedAt([itemVersionId, neverEscalated]));
    expect(found.get(itemVersionId)).toBe('2026-08-21T09:00:00.000Z');
    expect(found.has(neverEscalated)).toBe(false);
  });

  it('is an empty map, not an error, for an empty input', async () => {
    expect(expectValue(await repository.findNotifiedAt([]))).toEqual(new Map());
  });
});
