import type { Pool } from 'pg';
import { checkPayloadDiscipline } from './payload-discipline.js';

/**
 * The outbox relay (D17): drains `platform.outbox_message` to the consumers registered for each event type.
 *
 * **What it guarantees, and what it leaves to the consumer.**
 *
 *   - **At least once.** A message leaves the live backlog only when every consumer registered for its type has returned. A
 *     consumer that throws, a relay that dies mid-delivery and a lost acknowledgement all leave it claimable again (after a
 *     back-off, or when the lease runs out), so a consumer can be handed the same message more than once.
 *   - **Not exactly once, and it does not claim to be.** The *effect* happening at most once is the **consumer's** job: it
 *     must be idempotent on the message id (or on something in the payload). A consumer's effect and the relay's
 *     acknowledgement cannot be one transaction in general, so the duplicate is the price of never losing the message.
 *   - **In order per aggregate, among live messages.** Only the earliest live message of an aggregate (by occurrence) is
 *     claimable; a later one waits for it to be delivered. Across aggregates there is no order. A *dead-lettered* message
 *     stops blocking its aggregate, so a poison message cannot stall the rest: a consumer can see an aggregate's later
 *     message without the earlier one, and must not assume it saw every one. Ordering is by occurrence time, which is the
 *     producing transaction's clock reading and not its commit order.
 *   - **A poison message does not stall the queue.** After `maxAttempts` deliveries it is dead-lettered and kept, with the
 *     last error, for an operator to inspect and `requeue`. So is a message whose payload breaks the payload discipline —
 *     at once, without a consumer ever seeing it.
 *
 * **Time is supplied.** `drain(now)` takes the moment; the relay reads no clock, so a lease expiring or a back-off elapsing
 * is tested by passing a later `now`, never by waiting. Concurrent relays are safe: a claim is one statement that skips rows
 * another claim has locked.
 */
export interface OutboxEnvelope {
  readonly messageId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly principal: { readonly kind: string; readonly id: string };
  readonly correlationId: string;
  readonly occurredAt: string;
  /** How many times it has been handed out, this one included. 1 on first delivery. */
  readonly attempt: number;
}

export interface OutboxConsumer {
  readonly name: string;
  /** Throw to fail the delivery. Must be idempotent on `envelope.messageId`: the same message can arrive again. */
  handle(envelope: OutboxEnvelope): Promise<void>;
}

export interface RelayPolicy {
  readonly batchSize: number;
  /** How long a claim holds a message before another relay may take it (a crash leaves no one to release it). */
  readonly leaseMs: number;
  /** Deliveries before a message is dead-lettered. */
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** Rounds per drain: only the head of each aggregate is claimable, so a backlog takes several. */
  readonly maxRounds: number;
}

export const DEFAULT_RELAY_POLICY: RelayPolicy = Object.freeze({
  batchSize: 50,
  leaseMs: 60_000,
  maxAttempts: 5,
  retryBaseMs: 1_000,
  retryMaxMs: 300_000,
  maxRounds: 20,
});

export interface DrainReport {
  readonly claimed: number;
  readonly delivered: number;
  /** Failed and left claimable again. */
  readonly retried: number;
  /** Dead-lettered this drain, for exhausting its attempts. */
  readonly deadLettered: number;
  /** Dead-lettered this drain for breaking the payload discipline. */
  readonly refused: number;
}

export interface DeadLetter {
  readonly messageId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly deadAt: string;
}

interface MessageRow {
  readonly outbox_message_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload: Record<string, unknown>;
  readonly principal_kind: string;
  readonly principal_id: string;
  readonly correlation_id: string;
  readonly occurred_at: Date;
  readonly attempts: number;
}

/** Delivery order within a drain: by when it occurred, then by id, so the same backlog is delivered the same way every time. */
export function inDeliveryOrder(
  a: { readonly occurred_at: Date; readonly outbox_message_id: string },
  b: { readonly occurred_at: Date; readonly outbox_message_id: string },
): number {
  const byTime = a.occurred_at.getTime() - b.occurred_at.getTime();
  if (byTime !== 0) return byTime;
  if (a.outbox_message_id === b.outbox_message_id) return 0;
  return a.outbox_message_id < b.outbox_message_id ? -1 : 1;
}

const MAX_ERROR_LENGTH = 500;

function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export class OutboxRelay {
  readonly #consumers: ReadonlyMap<string, readonly OutboxConsumer[]>;

  constructor(
    private readonly pool: Pool,
    consumers: ReadonlyMap<string, readonly OutboxConsumer[]>,
    private readonly policy: RelayPolicy = DEFAULT_RELAY_POLICY,
  ) {
    this.#consumers = consumers;
  }

  /** Delivers what is due as of `now`, round after round until a round finds nothing or the policy's rounds are spent. */
  async drain(now: Date): Promise<DrainReport> {
    const total = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, refused: 0 };
    for (let round = 0; round < this.policy.maxRounds; round += 1) {
      const claimed = await this.#claim(now);
      if (claimed.length === 0) break;
      total.claimed += claimed.length;
      for (const row of claimed) {
        const outcome = await this.#deliver(row, now);
        total[outcome] += 1;
      }
    }
    return Object.freeze(total);
  }

  /** Dead-lettered messages, oldest first. */
  async listDead(limit = 100): Promise<readonly DeadLetter[]> {
    const { rows } = await this.pool.query<MessageRow & { dead_at: Date; last_error: string | null }>(
      `SELECT outbox_message_id, event_type, aggregate_type, aggregate_id, attempts, last_error, dead_at
         FROM platform.outbox_message WHERE dead_at IS NOT NULL ORDER BY dead_at, outbox_message_id LIMIT $1`,
      [limit],
    );
    return rows.map((row) =>
      Object.freeze({
        messageId: row.outbox_message_id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        attempts: row.attempts,
        lastError: row.last_error,
        deadAt: row.dead_at.toISOString(),
      }),
    );
  }

  /**
   * Puts a dead-lettered message back in the live backlog with its attempts cleared: what an operator does once the cause is
   * fixed. False when there is no such dead message. A message that broke the payload discipline will be refused again.
   */
  async requeue(messageId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE platform.outbox_message
          SET dead_at = NULL, attempts = 0, retry_at = NULL, claimed_until = NULL, last_error = NULL
        WHERE outbox_message_id = $1 AND dead_at IS NOT NULL`,
      [messageId],
    );
    return rowCount === 1;
  }

  async #claim(now: Date): Promise<readonly MessageRow[]> {
    const types = [...this.#consumers.keys()];
    if (types.length === 0) return [];
    const leaseEnds = new Date(now.getTime() + this.policy.leaseMs);
    const { rows } = await this.pool.query<MessageRow>(
      `WITH due AS (
         SELECT m.outbox_message_id
           FROM platform.outbox_message m
          WHERE m.published_at IS NULL AND m.dead_at IS NULL
            AND m.event_type = ANY($1)
            AND (m.claimed_until IS NULL OR m.claimed_until <= $2)
            AND (m.retry_at IS NULL OR m.retry_at <= $2)
            AND NOT EXISTS (
                  SELECT 1 FROM platform.outbox_message earlier
                   WHERE earlier.aggregate_type = m.aggregate_type AND earlier.aggregate_id = m.aggregate_id
                     AND earlier.published_at IS NULL AND earlier.dead_at IS NULL
                     AND earlier.event_type = ANY($1)
                     AND (earlier.occurred_at, earlier.outbox_message_id) < (m.occurred_at, m.outbox_message_id))
          ORDER BY m.occurred_at, m.outbox_message_id
          LIMIT $3
          FOR UPDATE OF m SKIP LOCKED)
       UPDATE platform.outbox_message o
          SET claimed_until = $4, attempts = o.attempts + 1
         FROM due
        WHERE o.outbox_message_id = due.outbox_message_id
        RETURNING o.outbox_message_id, o.event_type, o.schema_version, o.aggregate_type, o.aggregate_id, o.payload,
                  o.principal_kind, o.principal_id, o.correlation_id, o.occurred_at, o.attempts`,
      [types, now, this.policy.batchSize, leaseEnds],
    );
    return [...rows].sort(inDeliveryOrder);
  }

  async #deliver(row: MessageRow, now: Date): Promise<'delivered' | 'retried' | 'deadLettered' | 'refused'> {
    const violations = checkPayloadDiscipline(row.payload);
    if (violations.length > 0) {
      const reason = `PAYLOAD_DISCIPLINE: ${violations.map((violation) => `${violation.path} (${violation.reason})`).join(', ')}`;
      await this.#markDead(row.outbox_message_id, now, reason);
      return 'refused';
    }

    const envelope: OutboxEnvelope = Object.freeze({
      messageId: row.outbox_message_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: Object.freeze(row.payload),
      principal: Object.freeze({ kind: row.principal_kind, id: row.principal_id }),
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at.toISOString(),
      attempt: row.attempts,
    });

    try {
      // Only types with consumers are claimed, so the list is there.
      for (const consumer of this.#consumers.get(row.event_type) as readonly OutboxConsumer[]) await consumer.handle(envelope);
    } catch (error) {
      return this.#fail(row, now, describe(error));
    }
    await this.pool.query(
      `UPDATE platform.outbox_message SET published_at = $2, claimed_until = NULL, retry_at = NULL, last_error = NULL WHERE outbox_message_id = $1`,
      [row.outbox_message_id, now],
    );
    return 'delivered';
  }

  async #fail(row: MessageRow, now: Date, error: string): Promise<'retried' | 'deadLettered'> {
    if (row.attempts >= this.policy.maxAttempts) {
      await this.#markDead(row.outbox_message_id, now, error);
      return 'deadLettered';
    }
    const delay = Math.min(this.policy.retryBaseMs * 2 ** (row.attempts - 1), this.policy.retryMaxMs);
    await this.pool.query(
      `UPDATE platform.outbox_message SET claimed_until = NULL, retry_at = $2, last_error = $3 WHERE outbox_message_id = $1`,
      [row.outbox_message_id, new Date(now.getTime() + delay), error],
    );
    return 'retried';
  }

  async #markDead(messageId: string, now: Date, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform.outbox_message SET dead_at = $2, claimed_until = NULL, retry_at = NULL, last_error = $3 WHERE outbox_message_id = $1`,
      [messageId, now, error],
    );
  }
}
