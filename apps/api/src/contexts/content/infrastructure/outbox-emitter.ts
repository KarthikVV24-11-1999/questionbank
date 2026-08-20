import type { PoolClient } from 'pg';
import type { ContentEvent, ContentEventType } from '../domain/events/content-events.js';

/**
 * Events are written to `platform.outbox_message` **inside the same
 * transaction as the aggregate** (§9 rule 4, P4). The alternative — write,
 * commit, publish — loses the event whenever the process dies between the two,
 * and an `ItemPublished` nobody hears about is an item Assessment will never
 * assemble into a paper and Psychometrics will never key statistics on.
 *
 * The table belongs to platform and is created by M1's migration; content only
 * appends to it.
 *
 * **The payload is the event's own, unchanged.** It carries identifiers and
 * version numbers only (M3-18) — no stem, no key, no solution body — because
 * the outbox drains to analytics (P4/D17), which is exactly where a key must
 * never arrive. Nothing here enriches a payload on the way past.
 */

/** Which aggregate a row is attributed to, so a consumer can filter by type. */
const AGGREGATE_TYPE_BY_EVENT: Readonly<Record<ContentEventType, string>> = Object.freeze({
  ItemPublished: 'Item',
  ItemSuspended: 'Item',
  ItemRetired: 'Item',
  StimulusPublished: 'Stimulus',
  SolutionPublished: 'Solution',
  MediaAssetPublished: 'MediaAsset',
  // The review events are all facts about an Item under review — DEC-M4-7's
  // review workspace has no aggregate of its own to attribute them to.
  ReviewClaimed: 'Item',
  ReviewReleased: 'Item',
  ReviewDecided: 'Item',
  ItemReviewEscalated: 'Item',
});

/**
 * The aggregate a row is keyed on. Read off the payload rather than off a
 * shared field name: the six payloads name different identifiers, and a
 * `payload.id` convention would be one rename away from attributing an event
 * to the wrong aggregate.
 */
function aggregateIdOf(event: ContentEvent): string {
  switch (event.eventType) {
    case 'ItemPublished':
    case 'ItemSuspended':
    case 'ItemRetired':
      return event.payload.itemId;
    case 'StimulusPublished':
      return event.payload.stimulusId;
    case 'SolutionPublished':
      return event.payload.solutionId;
    case 'MediaAssetPublished':
      return event.payload.assetId;
    case 'ReviewClaimed':
    case 'ReviewReleased':
    case 'ReviewDecided':
    case 'ItemReviewEscalated':
      return event.payload.itemId;
  }
}

export class ContentOutboxEmitter {
  /** `client` is the transaction the aggregate was written in, never a fresh one. */
  async emit(client: PoolClient, event: ContentEvent): Promise<void> {
    await client.query(
      `INSERT INTO platform.outbox_message
         (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
          principal_kind, principal_id, correlation_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,
      [
        event.eventType,
        event.schemaVersion,
        AGGREGATE_TYPE_BY_EVENT[event.eventType],
        aggregateIdOf(event),
        JSON.stringify(event.payload),
        event.principal.kind,
        event.principal.id,
        event.correlationId,
        event.occurredAt,
      ],
    );
  }
}
