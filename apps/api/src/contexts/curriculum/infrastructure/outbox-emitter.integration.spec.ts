import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../domain/concept-identity.js';
import { ConceptNode } from '../domain/concept-node.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import {
  CURRICULUM_EVENT_REGISTRY,
  CURRICULUM_EVENT_TYPES,
} from '../domain/events/curriculum-events.js';
import { DrizzleConceptIdentityRepository } from './concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from './taxonomy-version.repository.js';
import {
  DrizzleOutboxEmitter,
  taxonomyVersionPublished,
  type DatabaseHandle,
} from './outbox-emitter.js';
import type { ApplicationContext } from '../application/ports.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;
let emitter: DrizzleOutboxEmitter;

const publisher: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['content_ops'] };
const context: ApplicationContext = { principal: publisher, correlationId: 'corr_outbox' };
const occurredAt = new Date('2026-08-05T13:00:00.000Z');

async function outboxCount(): Promise<number> {
  const result = await database.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform.outbox_message`,
  );
  return Number(result.rows[0]?.count);
}

/** A draft version with one node, stored and ready to publish. */
async function storedVersion(): Promise<{ version: TaxonomyVersion; aggregateVersion: number }> {
  const versions = new DrizzleTaxonomyVersionRepository(database.db);
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versionId = randomUUID();

  let version = expectValue(
    TaxonomyVersion.createDraft({ taxonomyVersionId: versionId, examFamily: 'JEE', academicYear: '2026' }),
  );
  expectValue(await versions.insert(version));

  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: randomUUID(),
      canonicalName: 'Physics',
      subjectDomain: 'physics',
      createdInVersion: versionId,
    }),
  );
  expectValue(await identities.insert(identity));

  version = expectValue(
    version.addConceptNode(
      expectValue(
        ConceptNode.createRoot({
          conceptNodeId: randomUUID(),
          conceptIdentityId: identity.conceptIdentityId,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
        }),
      ),
      identity,
    ),
  );
  expectValue(await versions.update(version, 1));

  return { version, aggregateVersion: 2 };
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  emitter = new DrizzleOutboxEmitter(database.db);
});

beforeEach(async () => {
  await database.truncateAll();
});

afterAll(async () => {
  await database.close();
});

describe('event registry', () => {
  it('declares the three curriculum events', () => {
    expect([...CURRICULUM_EVENT_TYPES]).toEqual([
      'TaxonomyVersionPublished',
      'ExamProfileVersionPublished',
      'TaxonomyMigrationExecuted',
    ]);
  });

  it('gives every event an analytics counterpart or an explicit exemption (F18)', () => {
    expect(CURRICULUM_EVENT_REGISTRY.map((entry) => entry.eventType)).toEqual([...CURRICULUM_EVENT_TYPES]);

    for (const entry of CURRICULUM_EVENT_REGISTRY) {
      const covered = entry.analyticsEvent !== null || entry.analyticsExemptionReason !== null;
      expect(covered, entry.eventType).toBe(true);
      expect(entry.schemaVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('names analytics events as domain.object_past_verb', () => {
    for (const entry of CURRICULUM_EVENT_REGISTRY) {
      if (entry.analyticsEvent === null) continue;
      expect(entry.analyticsEvent).toMatch(/^[a-z]+\.[a-z_]+$/u);
    }
  });
});

describe('event payloads', () => {
  it('carries identifiers only, never a nested aggregate', async () => {
    const { version } = await storedVersion();
    const published = expectValue(version.publish(publisher, occurredAt));

    const event = taxonomyVersionPublished(published, context, randomUUID(), occurredAt);

    expect(event.payload).toEqual({
      taxonomyVersionId: version.taxonomyVersionId,
      examFamily: 'JEE',
      academicYear: '2026',
      conceptCount: 1,
    });
    for (const value of Object.values(event.payload)) {
      expect(['string', 'number']).toContain(typeof value);
    }
  });
});

describe('outbox atomicity', () => {
  it('commits the aggregate change and the event together', async () => {
    const { version, aggregateVersion } = await storedVersion();
    const published = expectValue(version.publish(publisher, occurredAt));

    await emitter.emitWithin(async (handle: DatabaseHandle) => {
      const versions = new DrizzleTaxonomyVersionRepository(handle);
      const saved = await versions.update(published, aggregateVersion);
      return {
        result: saved,
        events: [taxonomyVersionPublished(published, context, randomUUID(), occurredAt)],
      };
    });

    const stored = await database.db.execute<{ state: string }>(
      sql`SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = ${version.taxonomyVersionId}`,
    );
    expect(stored.rows[0]?.state).toBe('published');
    expect(await outboxCount()).toBe(1);
  });

  it('rolls both back when the event write fails', async () => {
    const { version, aggregateVersion } = await storedVersion();
    const published = expectValue(version.publish(publisher, occurredAt));

    await expect(
      emitter.emitWithin(async (handle: DatabaseHandle) => {
        const versions = new DrizzleTaxonomyVersionRepository(handle);
        const saved = await versions.update(published, aggregateVersion);
        const broken = taxonomyVersionPublished(published, context, randomUUID(), occurredAt);
        return {
          result: saved,
          // A principal id that is not a uuid fails the insert.
          events: [{ ...broken, principal: { ...publisher, id: 'not-a-uuid' } }],
        };
      }),
    ).rejects.toThrow();

    const stored = await database.db.execute<{ state: string }>(
      sql`SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = ${version.taxonomyVersionId}`,
    );
    expect(stored.rows[0]?.state).toBe('draft');
    expect(await outboxCount()).toBe(0);
  });

  it('rolls the event back when the aggregate write fails', async () => {
    const { version, aggregateVersion } = await storedVersion();
    const published = expectValue(version.publish(publisher, occurredAt));

    await expect(
      emitter.emitWithin(async (handle: DatabaseHandle) => {
        const versions = new DrizzleTaxonomyVersionRepository(handle);
        await versions.update(published, aggregateVersion);
        throw new Error('aggregate write failed after the event was prepared');
      }),
    ).rejects.toThrow(/aggregate write failed/u);

    const stored = await database.db.execute<{ state: string }>(
      sql`SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = ${version.taxonomyVersionId}`,
    );
    expect(stored.rows[0]?.state).toBe('draft');
    expect(await outboxCount()).toBe(0);
  });

  it('stores the event with its type, schema version, principal and correlation id', async () => {
    const { version, aggregateVersion } = await storedVersion();
    const published = expectValue(version.publish(publisher, occurredAt));

    await emitter.emitWithin(async (handle: DatabaseHandle) => {
      const versions = new DrizzleTaxonomyVersionRepository(handle);
      const saved = await versions.update(published, aggregateVersion);
      return {
        result: saved,
        events: [taxonomyVersionPublished(published, context, randomUUID(), occurredAt)],
      };
    });

    const rows = await database.pool.query<{
      event_type: string;
      schema_version: number;
      aggregate_type: string;
      aggregate_id: string;
      correlation_id: string;
      principal_kind: string;
      published_at: Date | null;
      payload: Record<string, unknown>;
    }>(`SELECT * FROM platform.outbox_message`);

    expect(rows.rows[0]).toMatchObject({
      event_type: 'TaxonomyVersionPublished',
      schema_version: 1,
      aggregate_type: 'TaxonomyVersion',
      aggregate_id: version.taxonomyVersionId,
      correlation_id: 'corr_outbox',
      principal_kind: 'human',
      published_at: null,
    });
    expect(rows.rows[0]?.payload).toEqual({
      taxonomyVersionId: version.taxonomyVersionId,
      examFamily: 'JEE',
      academicYear: '2026',
      conceptCount: 1,
    });
  });

  it('has no foreign key from the outbox into a context schema (F2)', async () => {
    const result = await database.db.execute<{ conname: string }>(sql`
      SELECT con.conname FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      WHERE con.contype = 'f' AND ns.nspname = 'platform'
    `);

    expect(result.rows).toEqual([]);
  });

  it('gives the outbox payload column a schema version sibling (F5)', async () => {
    const result = await database.db.execute<{ column_name: string }>(sql`
      SELECT j.column_name FROM information_schema.columns j
      WHERE j.table_schema = 'platform' AND j.data_type = 'jsonb'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns v
          WHERE v.table_schema = j.table_schema AND v.table_name = j.table_name
            AND v.column_name = j.column_name || '_schema_version'
        )
    `);

    expect(result.rows).toEqual([]);
  });
});
