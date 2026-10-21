import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import type { RepositoryError, ResponseLog } from '../domain/repository-ports.js';
import type { ResponseAnswer, ResponseEvent, ResponseEventKind } from '../domain/response-event.js';
import { conflict, fromDatabaseError } from './repository-errors.js';

interface EventRow {
  readonly event_id: string;
  readonly attempt_id: string;
  readonly slot_id: string;
  readonly item_version_id: string;
  readonly sequence: string;
  readonly kind: ResponseEventKind;
  readonly answer: ResponseAnswer | null;
  readonly client_monotonic_ms: string;
  readonly server_received_at: Date;
  readonly device_ref: string;
  readonly after_submission: boolean;
}

const COLUMNS = `event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms,
                 server_received_at, device_ref, after_submission`;

function toEvent(row: EventRow): ResponseEvent {
  return Object.freeze({
    eventId: row.event_id,
    attemptId: row.attempt_id,
    slotId: row.slot_id,
    itemVersionId: row.item_version_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    answer: row.answer,
    clientMonotonicMs: Number(row.client_monotonic_ms),
    serverReceivedAt: row.server_received_at.toISOString(),
    deviceRef: row.device_ref,
    afterSubmission: row.after_submission,
  });
}

/**
 * What a retry of the same event must agree on. The receipt time and the
 * after-submission flag are the server's, assigned when the event first
 * arrived, so a replay legitimately differs in both.
 */
function sameEvent(stored: ResponseEvent, incoming: ResponseEvent): boolean {
  return (
    stored.attemptId === incoming.attemptId &&
    stored.slotId === incoming.slotId &&
    stored.itemVersionId === incoming.itemVersionId &&
    stored.sequence === incoming.sequence &&
    stored.kind === incoming.kind &&
    JSON.stringify(stored.answer) === JSON.stringify(incoming.answer) &&
    stored.clientMonotonicMs === incoming.clientMonotonicMs &&
    stored.deviceRef === incoming.deviceRef
  );
}

/**
 * The authoritative response log. A single INSERT is atomic on its own, so
 * there is no read-modify-write and no transaction: the event id is the
 * primary key, `ON CONFLICT DO NOTHING` is the idempotent replay, and the
 * database's trigger — not this class — decides whether the event counts.
 */
export class PostgresResponseLog implements ResponseLog {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append(event: ResponseEvent): Promise<Result<ResponseEvent, RepositoryError>> {
    try {
      const inserted = await this.#pool.query<EventRow>(
        `INSERT INTO assessment.response_event
           (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          event.eventId,
          event.attemptId,
          event.slotId,
          event.itemVersionId,
          event.sequence,
          event.kind,
          event.answer === null ? null : JSON.stringify(event.answer),
          event.clientMonotonicMs,
          event.serverReceivedAt,
          event.deviceRef,
        ],
      );
      if (inserted.rows[0] !== undefined) return ok(toEvent(inserted.rows[0]));

      // The id was already there: a replay if it says the same thing, a defect if it does not.
      const { rows } = await this.#pool.query<EventRow>(`SELECT ${COLUMNS} FROM assessment.response_event WHERE event_id = $1`, [event.eventId]);
      const stored = toEvent(rows[0] as EventRow);
      return sameEvent(stored, event) ? ok(stored) : err(conflict('an event with this id was already recorded with different content', 'eventId'));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findByAttempt(attemptId: string): Promise<Result<readonly ResponseEvent[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<EventRow>(
        `SELECT ${COLUMNS} FROM assessment.response_event WHERE attempt_id = $1 ORDER BY sequence, event_id`,
        [attemptId],
      );
      return ok(rows.map(toEvent));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async answeredSlotCount(attemptId: string): Promise<Result<number, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ answered: number }>(
        `SELECT count(DISTINCT slot_id)::int AS answered
           FROM assessment.response_event
          WHERE attempt_id = $1 AND kind IN ('select', 'change') AND NOT after_submission`,
        [attemptId],
      );
      return ok((rows[0] as { answered: number }).answered);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
