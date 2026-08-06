import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TaxonomyVersion } from '../domain/taxonomy-version.js';
import type { ExamProfileVersion } from '../domain/exam-profile-version.js';
import type { TaxonomyMigration } from '../domain/taxonomy-migration.js';
import type {
  CurriculumEvent,
  ExamProfileVersionPublished,
  TaxonomyMigrationExecuted,
  TaxonomyVersionPublished,
} from '../domain/events/curriculum-events.js';
import type { ApplicationContext } from '../application/ports.js';

export const platform = pgSchema('platform');

export const outboxMessage = platform.table('outbox_message', {
  outboxMessageId: uuid('outbox_message_id').primaryKey().default(sql`curriculum.uuid_generate_v7()`),
  tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
  eventType: text('event_type').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
  principalKind: text('principal_kind').notNull(),
  principalId: uuid('principal_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
});

/** Any drizzle handle — the pool or a transaction — the emitter can write to. */
export type DatabaseHandle = NodePgDatabase;

export function taxonomyVersionPublished(
  version: TaxonomyVersion,
  context: ApplicationContext,
  eventId: string,
  occurredAt: Date,
): TaxonomyVersionPublished {
  return {
    eventId,
    eventType: 'TaxonomyVersionPublished',
    schemaVersion: 1,
    occurredAt,
    principal: context.principal,
    correlationId: context.correlationId,
    payload: {
      taxonomyVersionId: version.taxonomyVersionId,
      examFamily: version.examFamily,
      academicYear: version.academicYear,
      conceptCount: version.nodes.length,
    },
  };
}

export function examProfileVersionPublished(
  profile: ExamProfileVersion,
  context: ApplicationContext,
  eventId: string,
  occurredAt: Date,
): ExamProfileVersionPublished {
  return {
    eventId,
    eventType: 'ExamProfileVersionPublished',
    schemaVersion: 1,
    occurredAt,
    principal: context.principal,
    correlationId: context.correlationId,
    payload: {
      profileVersionId: profile.profileVersionId,
      examId: profile.examId,
      academicYear: profile.academicYear,
      taxonomyVersionId: profile.taxonomyVersionId,
      markingRuleSetHash: profile.markingRuleSetHash ?? '',
    },
  };
}

export function taxonomyMigrationExecuted(
  migration: TaxonomyMigration,
  context: ApplicationContext,
  eventId: string,
  occurredAt: Date,
): TaxonomyMigrationExecuted {
  return {
    eventId,
    eventType: 'TaxonomyMigrationExecuted',
    schemaVersion: 1,
    occurredAt,
    principal: context.principal,
    correlationId: context.correlationId,
    payload: {
      migrationId: migration.migrationId,
      fromVersionId: migration.fromVersionId,
      toVersionId: migration.toVersionId,
      mappingCount: migration.mappings.length,
    },
  };
}

const AGGREGATE_TYPE_OF: Record<CurriculumEvent['eventType'], string> = {
  TaxonomyVersionPublished: 'TaxonomyVersion',
  ExamProfileVersionPublished: 'ExamProfileVersion',
  TaxonomyMigrationExecuted: 'TaxonomyMigration',
};

function aggregateIdOf(event: CurriculumEvent): string {
  switch (event.eventType) {
    case 'TaxonomyVersionPublished':
      return event.payload.taxonomyVersionId;
    case 'ExamProfileVersionPublished':
      return event.payload.profileVersionId;
    default:
      return event.payload.migrationId;
  }
}

/**
 * Writes curriculum events to the outbox. The handle passed in is the one the
 * aggregate was written with, so the event and the aggregate change commit or
 * roll back together (P4).
 */
export class DrizzleOutboxEmitter {
  constructor(private readonly db: DatabaseHandle) {}

  async emit(event: CurriculumEvent, handle: DatabaseHandle = this.db): Promise<void> {
    await handle.insert(outboxMessage).values({
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      aggregateType: AGGREGATE_TYPE_OF[event.eventType],
      aggregateId: aggregateIdOf(event),
      payload: event.payload,
      principalKind: event.principal.kind,
      principalId: event.principal.id,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
    });
  }

  /**
   * Runs an aggregate change and its events in one transaction. If either
   * fails, neither is committed.
   */
  async emitWithin<T>(
    work: (handle: DatabaseHandle) => Promise<{ result: T; events: readonly CurriculumEvent[] }>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const handle = tx as unknown as DatabaseHandle;
      const { result, events } = await work(handle);
      for (const event of events) await this.emit(event, handle);
      return result;
    });
  }

  async unpublished(): Promise<readonly (typeof outboxMessage.$inferSelect)[]> {
    return this.db.select().from(outboxMessage);
  }
}
