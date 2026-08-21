import { err, ok, type Result } from '../../domain/result.js';
import { validationError } from '../../domain/content-error.js';
import type {
  EscalateReviewVersion,
  RepositoryError,
  ReviewEscalationRepository,
  TransactionContext,
} from '../../domain/repository-ports.js';
import type { ItemReviewEscalated } from '../../domain/events/content-events.js';
import { clientOf } from '../transaction-runner.js';

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'reviewEscalation');
}

/**
 * The escalation row and its outbox event, written together (M4-31).
 *
 * **The outbox insert is inlined here rather than shared with
 * `infrastructure/outbox-emitter.ts`'s `ContentOutboxEmitter`.** That module
 * is authoring-side, ordinary infrastructure — not one of the M4-01
 * sub-boundary gate's four named shared contracts — so review plumbing may
 * not import it. Two statements is the same trade `review-decision.repository.ts`
 * already made for the assignment-transition write: a smaller cost than a
 * fifth gate exemption. `aggregate_type` is hardcoded to `'Item'`, matching
 * `ContentOutboxEmitter`'s own `AGGREGATE_TYPE_BY_EVENT['ItemReviewEscalated']` —
 * the one place the two must agree, and `review-escalation.repository.integration.spec.ts`
 * proves the row this writes matches what the shared emitter would have
 * written for the same event.
 */
export class PostgresReviewEscalationRepository implements ReviewEscalationRepository {
  async escalateIfNew(
    criteria: EscalateReviewVersion,
    event: ItemReviewEscalated,
    tx: TransactionContext,
  ): Promise<Result<boolean, RepositoryError>> {
    const client = clientOf(tx);
    try {
      const existing = await client.query(
        `SELECT 1 FROM content.review_escalation WHERE item_version_id = $1 LIMIT 1`,
        [criteria.itemVersionId],
      );
      if (existing.rowCount !== 0) return ok(false);

      await client.query(
        `INSERT INTO content.review_escalation (item_id, item_version_id, target_role, reason, escalated_at)
         VALUES ($1, $2, 'content_ops', $3, $4)`,
        [criteria.itemId, criteria.itemVersionId, criteria.reason, criteria.escalatedAt],
      );

      await client.query(
        `INSERT INTO platform.outbox_message
           (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
            principal_kind, principal_id, correlation_id, occurred_at)
         VALUES ($1,$2,'Item',$3,$4,1,$5,$6,$7,$8)`,
        [
          event.eventType,
          event.schemaVersion,
          event.payload.itemId,
          JSON.stringify(event.payload),
          event.principal.kind,
          event.principal.id,
          event.correlationId,
          event.occurredAt,
        ],
      );

      return ok(true);
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
  }
}
