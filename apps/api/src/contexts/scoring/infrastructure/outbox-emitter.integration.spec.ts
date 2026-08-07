import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import type { AttemptScored, AttemptsRescored } from '../domain/events/scoring-events.js';
import { ScoringOutboxEmitter } from './outbox-emitter.js';

/**
 * §9 rule 4: the event is written **inside the aggregate's transaction**.
 *
 * Write-then-publish loses the event whenever the process dies between the
 * two, and a score Psychometrics never hears about is one that silently never
 * reaches a learner's analytics. Asserting that means rolling a transaction
 * back and proving the event went with it — which is what this spec does, and
 * what nothing did before it.
 */
let database: TestDatabase;
const emitter = new ScoringOutboxEmitter();

const principal: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['ops'] };

const scored = (): AttemptScored => ({
  eventId: randomUUID(),
  eventType: 'AttemptScored',
  schemaVersion: 1,
  occurredAt: new Date('2026-08-07T00:00:00.000Z'),
  principal,
  correlationId: 'c-1',
  payload: {
    scoreRecordId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    markingRuleSetHash: '4fe24605633c',
    ruleSchemaVersion: 1,
    totalRaw: '7',
    totalMaxAvailable: '12',
  },
});

const rescored = (): AttemptsRescored => ({
  eventId: randomUUID(),
  eventType: 'AttemptsRescored',
  schemaVersion: 1,
  occurredAt: new Date('2026-08-07T00:00:00.000Z'),
  principal,
  correlationId: 'c-2',
  payload: { rescoringOperationId: randomUUID(), attemptCount: 3, trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION' },
});

async function outboxRows(eventId: string) {
  const found = await database.pool.query(
    `SELECT event_type, aggregate_type, aggregate_id, payload, payload_schema_version,
            principal_kind, principal_id, correlation_id
       FROM platform.outbox_message WHERE payload->>'scoreRecordId' = $1
          OR payload->>'rescoringOperationId' = $1`,
    [eventId],
  );
  return found.rows;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('the event is written in the aggregate transaction', () => {
  it('commits the event with the work', async () => {
    const event = scored();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await emitter.emit(client, event);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await outboxRows(event.payload.scoreRecordId)).toHaveLength(1);
  });

  it('loses the event when the transaction rolls back — write-then-publish cannot do this', async () => {
    const event = scored();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await emitter.emit(client, event);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await outboxRows(event.payload.scoreRecordId)).toEqual([]);
  });
});

describe('the row a consumer reads', () => {
  it('records the aggregate an AttemptScored belongs to', async () => {
    const event = scored();
    const client = await database.pool.connect();
    await client.query('BEGIN');
    await emitter.emit(client, event);
    await client.query('COMMIT');
    client.release();

    const [row] = await outboxRows(event.payload.scoreRecordId);
    expect(row).toMatchObject({
      event_type: 'AttemptScored',
      aggregate_type: 'ScoreRecord',
      aggregate_id: event.payload.scoreRecordId,
      principal_kind: 'human',
      correlation_id: 'c-1',
      payload_schema_version: 1,
    });
  });

  it('records the operation an AttemptsRescored belongs to', async () => {
    const event = rescored();
    const client = await database.pool.connect();
    await client.query('BEGIN');
    await emitter.emit(client, event);
    await client.query('COMMIT');
    client.release();

    const [row] = await outboxRows(event.payload.rescoringOperationId);
    expect(row).toMatchObject({
      event_type: 'AttemptsRescored',
      aggregate_type: 'RescoringOperation',
      aggregate_id: event.payload.rescoringOperationId,
    });
  });

  it('carries the total as decimal text, so no consumer reads a mark through a double', async () => {
    const event = scored();
    const client = await database.pool.connect();
    await client.query('BEGIN');
    await emitter.emit(client, event);
    await client.query('COMMIT');
    client.release();

    const [row] = await outboxRows(event.payload.scoreRecordId);
    const payload = (row as { payload: Record<string, unknown> }).payload;
    expect(typeof payload['totalRaw']).toBe('string');
    expect(payload['totalRaw']).toBe('7');
  });

  it('carries no answer key, response payload or PII (§9 rules 10 and 12)', async () => {
    const event = scored();
    const client = await database.pool.connect();
    await client.query('BEGIN');
    await emitter.emit(client, event);
    await client.query('COMMIT');
    client.release();

    const [row] = await outboxRows(event.payload.scoreRecordId);
    const serialized = JSON.stringify((row as { payload: unknown }).payload);
    for (const forbidden of ['answerKey', 'optionId', 'correctOptionIds', 'responseSnapshot', 'expectedValue', 'email']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves the message unpublished for the relay to pick up', async () => {
    const event = scored();
    const client = await database.pool.connect();
    await client.query('BEGIN');
    await emitter.emit(client, event);
    await client.query('COMMIT');
    client.release();

    const found = await database.pool.query(
      `SELECT published_at, attempts FROM platform.outbox_message
        WHERE payload->>'scoreRecordId' = $1`,
      [event.payload.scoreRecordId],
    );
    expect(found.rows[0]).toMatchObject({ published_at: null, attempts: 0 });
  });
});
