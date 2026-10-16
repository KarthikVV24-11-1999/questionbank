import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { GENERATION_EVENT_TYPES, type GenerationEvent } from '../domain/events/generation-events.js';
import { PRINCIPAL } from '../../../testing/generation-fixtures.js';
import { GenerationOutboxEmitter } from './outbox-emitter.js';

/**
 * §9 rule 4: the event is written **inside the candidate's transaction**.
 * Proving that means rolling a transaction back and showing the event went with
 * it (the M2-26 method) — the repository specs prove the same through `save`.
 */
let database: TestDatabase;
const emitter = new GenerationOutboxEmitter();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

function event(eventType: (typeof GENERATION_EVENT_TYPES)[number], candidateId: string): GenerationEvent {
  const envelope = {
    schemaVersion: 1,
    occurredAt: '2026-10-16T10:00:00.000Z',
    principal: PRINCIPAL,
    correlationId: 'corr-9',
    candidateId,
    pin: { modelVersionId: '00000000-0000-4000-8000-0000000a0003', promptVersionId: '00000000-0000-4000-8000-0000000b0007', runId: '00000000-0000-4000-8000-0000000c0001' },
  };
  return eventType === 'CandidateAccepted'
    ? { ...envelope, eventType, contentItemId: '00000000-0000-4000-8000-0000000000aa' }
    : { ...envelope, eventType };
}

async function rowsFor(candidateId: string) {
  const { rows } = await database.pool.query(`SELECT event_type FROM platform.outbox_message WHERE aggregate_id = $1`, [candidateId]);
  return rows.map((row: { event_type: string }) => row.event_type);
}

describe('the generation outbox emitter', () => {
  it('writes a row for each event type the context publishes', async () => {
    const candidateId = randomUUID();
    const client = await database.pool.connect();
    try {
      for (const type of GENERATION_EVENT_TYPES) await emitter.emit(client, event(type, candidateId));
    } finally {
      client.release();
    }
    expect((await rowsFor(candidateId)).sort()).toEqual([...GENERATION_EVENT_TYPES].sort());
  });

  it('takes the event with it when the transaction rolls back', async () => {
    const candidateId = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await emitter.emit(client, event('CandidateAccepted', candidateId));
      expect((await client.query(`SELECT 1 FROM platform.outbox_message WHERE aggregate_id = $1`, [candidateId])).rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await rowsFor(candidateId)).toEqual([]);
  });

  // The payload is picked field by field, so a property that should never have
  // been on an event cannot ride into a table that drains to analytics.
  it('carries no stem, key or solution even when an event arrives bearing them', async () => {
    const candidateId = randomUUID();
    const hostile = {
      ...event('CandidateAccepted', candidateId),
      stem: 'A block slides down a ramp',
      correctOptionId: 'b',
      solution: { steps: ['s1'] },
    } as unknown as GenerationEvent;
    const client = await database.pool.connect();
    try {
      await emitter.emit(client, hostile);
    } finally {
      client.release();
    }
    const { rows } = await database.pool.query(`SELECT payload FROM platform.outbox_message WHERE aggregate_id = $1`, [candidateId]);
    expect(Object.keys(rows[0].payload).sort()).toEqual(['candidateId', 'contentItemId', 'pin']);
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/block slides|correctOptionId|steps/u);
  });
});
