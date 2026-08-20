import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import {
  CONTENT_EVENT_REGISTRY,
  CONTENT_EVENT_TYPES,
  registrationFor,
  type ContentEvent,
  type ContentEventType,
} from '../domain/events/content-events.js';
import { ContentOutboxEmitter } from './outbox-emitter.js';

/**
 * §9 rule 4 and P4: the event is written **inside the aggregate's
 * transaction**. Write-then-publish loses the event whenever the process dies
 * between the two, and an `ItemPublished` nobody hears about is an item
 * Assessment never assembles and Psychometrics never keys on.
 *
 * Proving that means rolling a transaction back and showing the event went
 * with it, which is the M2-26 method.
 */

let database: TestDatabase;
const emitter = new ContentOutboxEmitter();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const principal: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['content_ops'] };

const ITEM_ID = randomUUID();
const STIMULUS_ID = randomUUID();
const SOLUTION_ID = randomUUID();
const ASSET_ID = randomUUID();

function envelope<T extends ContentEventType>(eventType: T) {
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: 1,
    occurredAt: new Date('2026-08-11T09:00:00.000Z'),
    principal,
    correlationId: 'corr-1',
  } as const;
}

/** One of every event type, so the payload inspection covers all ten (M4-12). */
function eventOfEveryType(): readonly ContentEvent[] {
  return [
    {
      ...envelope('ItemPublished'),
      payload: {
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        itemType: 'SINGLE_CORRECT_MCQ',
        versionNo: 1,
        sourceType: 'original',
        primaryConceptIdentityId: randomUUID(),
        taxonomyVersionId: randomUUID(),
      },
    },
    {
      ...envelope('ItemSuspended'),
      payload: { itemId: ITEM_ID, itemVersionId: randomUUID(), reason: 'defect report under investigation' },
    },
    {
      ...envelope('ItemRetired'),
      payload: {
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        retirementReason: 'syllabus removed this concept',
      },
    },
    {
      ...envelope('StimulusPublished'),
      payload: {
        stimulusId: STIMULUS_ID,
        stimulusVersionId: randomUUID(),
        stimulusType: 'passage',
        versionNo: 1,
      },
    },
    {
      ...envelope('SolutionPublished'),
      payload: {
        solutionId: SOLUTION_ID,
        solutionVersionId: randomUUID(),
        itemId: ITEM_ID,
        targetItemVersionId: randomUUID(),
      },
    },
    {
      ...envelope('MediaAssetPublished'),
      payload: {
        assetId: ASSET_ID,
        assetVersionId: randomUUID(),
        assetType: 'diagram',
        mimeType: 'image/png',
      },
    },
    {
      ...envelope('ReviewClaimed'),
      payload: {
        assignmentId: randomUUID(),
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        subject: 'physics',
        assignmentType: 'claimed',
      },
    },
    {
      ...envelope('ReviewReleased'),
      payload: {
        assignmentId: randomUUID(),
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        releaseType: 'released',
      },
    },
    {
      ...envelope('ReviewDecided'),
      payload: {
        decisionId: randomUUID(),
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        outcomeType: 'reject',
        reasonCode: 'DUPLICATE',
        duplicateOfItemId: randomUUID(),
      },
    },
    {
      ...envelope('ItemReviewEscalated'),
      payload: {
        itemId: ITEM_ID,
        itemVersionId: randomUUID(),
        subject: 'physics',
        targetRoleType: 'content_ops',
      },
    },
  ];
}

interface OutboxRow {
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload: Record<string, unknown>;
  readonly payload_schema_version: number;
  readonly principal_kind: string;
  readonly principal_id: string;
  readonly correlation_id: string;
  readonly occurred_at: Date;
  readonly published_at: Date | null;
}

async function rowsFor(correlationId: string): Promise<readonly OutboxRow[]> {
  const found = await database.pool.query<OutboxRow>(
    `SELECT * FROM platform.outbox_message WHERE correlation_id = $1 ORDER BY event_type`,
    [correlationId],
  );
  return found.rows;
}

describe('an event is written inside the aggregate’s transaction', () => {
  it('lands with the commit', async () => {
    const correlationId = `commit-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await rowsFor(correlationId);
    expect(rows.map((row) => row.event_type).sort()).toEqual([...CONTENT_EVENT_TYPES].sort());
  });

  // The whole point. A publication that rolled back must leave nothing behind
  // claiming it happened.
  it('goes with the rollback', async () => {
    const correlationId = `rollback-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await rowsFor(correlationId)).toEqual([]);
  });

  it('attributes each event to its own aggregate', async () => {
    const correlationId = `aggregate-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await rowsFor(correlationId);
    const byType = new Map(rows.map((row) => [row.event_type, row]));
    expect(byType.get('ItemPublished')).toMatchObject({ aggregate_type: 'Item', aggregate_id: ITEM_ID });
    expect(byType.get('ItemSuspended')).toMatchObject({ aggregate_type: 'Item', aggregate_id: ITEM_ID });
    expect(byType.get('ItemRetired')).toMatchObject({ aggregate_type: 'Item', aggregate_id: ITEM_ID });
    expect(byType.get('StimulusPublished')).toMatchObject({
      aggregate_type: 'Stimulus',
      aggregate_id: STIMULUS_ID,
    });
    expect(byType.get('SolutionPublished')).toMatchObject({
      aggregate_type: 'Solution',
      aggregate_id: SOLUTION_ID,
    });
    expect(byType.get('MediaAssetPublished')).toMatchObject({
      aggregate_type: 'MediaAsset',
      aggregate_id: ASSET_ID,
    });
  });

  it('carries the envelope the relay needs and leaves it unpublished', async () => {
    const correlationId = `envelope-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await emitter.emit(client, { ...eventOfEveryType()[0]!, correlationId } as ContentEvent);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const row = (await rowsFor(correlationId))[0]!;
    expect(row).toMatchObject({
      schema_version: 1,
      payload_schema_version: 1,
      principal_kind: 'human',
      principal_id: principal.id,
      correlation_id: correlationId,
    });
    expect(row.occurred_at.toISOString()).toBe('2026-08-11T09:00:00.000Z');
    // The relay drains what has not been published; a row that arrived already
    // published would never be sent.
    expect(row.published_at).toBeNull();
  });
});

describe('what a payload may not carry (§9 rules 10, 12)', () => {
  // The outbox drains to analytics (P4/D17), which is exactly where a key must
  // never arrive — so the inspection runs on the stored row, not on the object
  // in memory that produced it.
  const FORBIDDEN_FIELDS = [
    'stem',
    'body',
    'responseSpec',
    'correctOptionId',
    'correctOptionIds',
    'isCorrect',
    'answerKey',
    'expectedValue',
    'toleranceValue',
    'pairs',
    'options',
    'steps',
    'finalAnswer',
    'finalAnswerAssertion',
    'misconception',
    'distractorAnalyses',
    'alternateApproaches',
    'email',
    'name',
    'phone',
  ] as const;

  it('stores no content, no key and no PII in any event type', async () => {
    const correlationId = `payload-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await rowsFor(correlationId);
    expect(rows).toHaveLength(CONTENT_EVENT_TYPES.length);

    for (const row of rows) {
      const serialized = JSON.stringify(row.payload);
      for (const field of FORBIDDEN_FIELDS) {
        expect(serialized, `${row.event_type} carries ${field}`).not.toContain(`"${field}"`);
      }
    }
  });

  it('carries only identifiers, version numbers and closed-vocabulary members', async () => {
    const correlationId = `shape-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // `reason` and `retirementReason` are the two free-text fields, and both
    // are an operator's justification for a governance act — not content.
    // `Code$` (M4-12's `reasonCode`) is a closed-vocabulary member the same
    // way `Type$` fields are; `subject` (M4-12) is a routing key from
    // curriculum's own closed set, not free text.
    const permitted = /Id$|Ids$|^versionNo$|Type$|Code$|^subject$|^reason$|^retirementReason$/u;
    for (const row of await rowsFor(correlationId)) {
      for (const key of Object.keys(row.payload)) {
        expect(permitted.test(key), `${row.event_type}.${key}`).toBe(true);
      }
    }
  });
});

describe('F18 — every event reconciles against the taxonomy', () => {
  const TAXONOMY = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../docs/EVENT-TAXONOMY.md'),
    'utf8',
  );

  it('registers every event type exactly once', () => {
    expect(CONTENT_EVENT_REGISTRY.map((entry) => entry.eventType).sort()).toEqual(
      [...CONTENT_EVENT_TYPES].sort(),
    );
  });

  it('gives each event either a counterpart or a written exemption, never both and never neither', () => {
    for (const eventType of CONTENT_EVENT_TYPES) {
      const registration = registrationFor(eventType);
      expect(registration, eventType).toBeDefined();
      const hasCounterpart = registration!.analyticsEvent !== null;
      const hasExemption = registration!.analyticsExemptionReason !== null;
      expect(hasCounterpart !== hasExemption, eventType).toBe(true);
    }
  });

  it('names a counterpart the taxonomy actually publishes', () => {
    for (const entry of CONTENT_EVENT_REGISTRY) {
      if (entry.analyticsEvent === null) continue;
      expect(TAXONOMY, entry.analyticsEvent).toContain(entry.analyticsEvent);
    }
  });

  it('emits every registered type and nothing else', async () => {
    const correlationId = `registry-${randomUUID()}`;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of eventOfEveryType()) {
        await emitter.emit(client, { ...event, correlationId } as ContentEvent);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const emitted = (await rowsFor(correlationId)).map((row) => row.event_type).sort();
    expect(emitted).toEqual(CONTENT_EVENT_REGISTRY.map((entry) => entry.eventType).sort());
  });
});
