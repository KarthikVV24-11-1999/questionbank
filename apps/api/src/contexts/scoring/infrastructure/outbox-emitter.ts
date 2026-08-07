import type { PoolClient } from 'pg';
import type { ScoringEvent } from '../domain/events/scoring-events.js';

/**
 * Events are written to `platform.outbox_message` **inside the same
 * transaction as the aggregate** (§9 rule 4). The alternative — write, commit,
 * publish — loses the event whenever the process dies between the two, and a
 * score that Psychometrics never hears about is a score that silently never
 * reaches a learner's analytics.
 *
 * The table belongs to platform and is created by M1's migration; scoring only
 * appends to it.
 */
export class ScoringOutboxEmitter {
  /** `client` is the transaction the aggregate was written in, never a fresh one. */
  async emit(client: PoolClient, event: ScoringEvent): Promise<void> {
    await client.query(
      `INSERT INTO platform.outbox_message
         (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
          principal_kind, principal_id, correlation_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,
      [
        event.eventType,
        event.schemaVersion,
        event.eventType === 'AttemptScored' ? 'ScoreRecord' : 'RescoringOperation',
        event.eventType === 'AttemptScored'
          ? event.payload.scoreRecordId
          : event.payload.rescoringOperationId,
        JSON.stringify(event.payload),
        event.principal.kind,
        event.principal.id,
        event.correlationId,
        event.occurredAt,
      ],
    );
  }
}
