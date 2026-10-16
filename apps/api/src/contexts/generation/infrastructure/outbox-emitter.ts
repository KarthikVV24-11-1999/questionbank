import type { PoolClient } from 'pg';
import type { GenerationEvent } from '../domain/events/generation-events.js';

/**
 * Events are written to `platform.outbox_message` **inside the same
 * transaction as the candidate** (§9 rule 4): write-then-publish loses the
 * event whenever the process dies between the two, and a `CandidateAccepted`
 * nobody hears about is a candidate that became a draft with no trace of why.
 *
 * The table belongs to platform; generation only appends to it.
 *
 * **The payload is identifiers and the pin, nothing else** (and, for an acceptance, the id of the content draft it became) — never the
 * proposed content, which is content's to hold once accepted, and the outbox
 * drains to analytics.
 */
const AGGREGATE_TYPE = 'GenerationCandidate';

/** Picked field by field, so a stray property on an event can never ride into the outbox. */
function payloadOf(event: GenerationEvent): Record<string, unknown> {
  const payload = { candidateId: event.candidateId, pin: event.pin };
  return event.eventType === 'CandidateAccepted' ? { ...payload, contentItemId: event.contentItemId } : payload;
}

export class GenerationOutboxEmitter {
  /** `client` is the transaction the candidate was written in, never a fresh one. */
  async emit(client: PoolClient, event: GenerationEvent): Promise<void> {
    await client.query(
      `INSERT INTO platform.outbox_message
         (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
          principal_kind, principal_id, correlation_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,
      [
        event.eventType,
        event.schemaVersion,
        AGGREGATE_TYPE,
        event.candidateId,
        JSON.stringify(payloadOf(event)),
        event.principal.kind,
        event.principal.id,
        event.correlationId,
        event.occurredAt,
      ],
    );
  }
}
