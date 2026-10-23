import type { PoolClient } from 'pg';
import type { AssessmentEvent } from '../domain/events/assessment-events.js';

/**
 * Appends an event to `platform.outbox_message` **inside the transaction the aggregate was written in** (§9 rule 4): the state
 * change and the event commit together or not at all. The alternative — commit, then publish — loses the event whenever the
 * process dies between the two, which for a submission means an attempt nothing ever scores.
 */
export class AssessmentOutboxEmitter {
  /** `client` is the transaction the aggregate was written in, never a fresh one. */
  async emit(client: PoolClient, event: AssessmentEvent): Promise<void> {
    await client.query(
      `INSERT INTO platform.outbox_message
         (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
          principal_kind, principal_id, correlation_id, occurred_at)
       VALUES ($1, $2, 'Attempt', $3, $4, 1, $5, $6, $7, $8)`,
      [event.eventType, event.schemaVersion, event.payload.attemptId, JSON.stringify(event.payload), event.principal.kind, event.principal.id, event.correlationId, event.occurredAt],
    );
  }
}
