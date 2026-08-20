import type { Pool } from 'pg';
import { GENESIS_PREV_HASH, recordHash, type AuditLinkRecord } from './audit-link.js';

/**
 * The audit chain's read path (M4-23, DEC-M4-4 → ADR-0020) — how a row
 * becomes something `audit-link.ts` can hash again.
 *
 * **Nothing here writes a link.** The chain is computed by a `BEFORE INSERT`
 * trigger in the database, because a chain the application computes is
 * bypassed by any other writer and "any other writer" is the adversary. This
 * module reads what the trigger wrote so the verifier (M4-25) and the
 * SQL/TypeScript equality test can recompute it independently.
 *
 * **`occurred_at` is read as text, never as a `Date`.** `timestamptz` carries
 * microseconds and a JS `Date` does not, so letting the driver parse the
 * column truncates `.123456` to `.123` and the recomputed hash would differ
 * from the stored one for any record written with sub-millisecond precision.
 * `SELECT_CHAIN_ROW` renders it with the same `to_char` format the trigger
 * uses. Verified against Postgres 16 rather than assumed.
 *
 * **`chain_seq` is read as text and parsed.** It is `bigint`, which the driver
 * hands back as a string rather than silently losing precision. A chain would
 * have to exceed 2^53 records before `number` became the wrong carrier, which
 * `assertSafeSeq` refuses rather than rounds.
 */

/**
 * Every column the chain needs, aliased to `AuditLinkRecord`'s field names
 * and cast so the driver cannot reinterpret one. Used by the verifier and by
 * the SQL/TypeScript byte-identity test, so both read through exactly the
 * same projection.
 */
export const SELECT_CHAIN_ROW = `
  audit_record_id::text AS "auditRecordId",
  principal_kind        AS "principalKind",
  principal_id          AS "principalId",
  action                AS "action",
  target_context        AS "targetContext",
  target_type           AS "targetType",
  target_id             AS "targetId",
  target_version        AS "targetVersion",
  correlation_id        AS "correlationId",
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
  justification         AS "justification",
  chain_seq::text       AS "chainSeq",
  prev_hash             AS "prevHash",
  record_hash           AS "recordHash"
`;

interface ChainRowShape extends Omit<AuditLinkRecord, never> {
  readonly chainSeq: string;
  readonly prevHash: Buffer;
  readonly recordHash: Buffer;
}

export interface ChainRow {
  readonly chainSeq: number;
  readonly prevHash: Buffer;
  readonly recordHash: Buffer;
  /** The same row, in the shape `audit-link.ts` canonicalizes. */
  readonly record: AuditLinkRecord;
}

export class AuditChainError extends Error {
  constructor(message: string) {
    super(`audit_chain: ${message}`);
    this.name = 'AuditChainError';
  }
}

function assertSafeSeq(raw: string): number {
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq)) {
    throw new AuditChainError(`chain_seq ${raw} exceeds the safe integer range`);
  }
  return seq;
}

function toChainRow(row: ChainRowShape): ChainRow {
  return Object.freeze({
    chainSeq: assertSafeSeq(row.chainSeq),
    prevHash: row.prevHash,
    recordHash: row.recordHash,
    record: Object.freeze({
      auditRecordId: row.auditRecordId,
      principalKind: row.principalKind,
      principalId: row.principalId,
      action: row.action,
      targetContext: row.targetContext,
      targetType: row.targetType,
      targetId: row.targetId,
      targetVersion: row.targetVersion,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
      justification: row.justification,
    }),
  });
}

/**
 * One bounded page of the chain, in sequence order. Bounded and ordered so
 * the verifier can stream a window rather than load the table — an audit log
 * is the one table guaranteed to grow forever.
 */
export async function readChainPage(
  pool: Pool,
  fromSeq: number,
  limit: number,
): Promise<readonly ChainRow[]> {
  const found = await pool.query<ChainRowShape>(
    `SELECT ${SELECT_CHAIN_ROW}
       FROM platform.audit_record
      WHERE chain_seq >= $1
      ORDER BY chain_seq
      LIMIT $2`,
    [fromSeq, limit],
  );
  return found.rows.map(toChainRow);
}

/** The last link, or `null` when nothing has been audited yet. */
export async function readChainHead(pool: Pool): Promise<ChainRow | null> {
  const found = await pool.query<ChainRowShape>(
    `SELECT ${SELECT_CHAIN_ROW}
       FROM platform.audit_record
      ORDER BY chain_seq DESC
      LIMIT 1`,
  );
  return found.rowCount === 0 ? null : toChainRow(found.rows[0]!);
}

/** The sequence range covering a UTC day, or `null` when the day holds no records. */
export async function readSeqRangeForDay(
  pool: Pool,
  day: string,
): Promise<{ readonly firstSeq: number; readonly lastSeq: number; readonly recordCount: number } | null> {
  const found = await pool.query<{ first: string | null; last: string | null; count: string }>(
    `SELECT min(chain_seq)::text AS first, max(chain_seq)::text AS last, count(*)::text AS count
       FROM platform.audit_record
      WHERE occurred_at >= $1::date AND occurred_at < ($1::date + interval '1 day')`,
    [day],
  );
  const row = found.rows[0]!;
  if (row.first === null || row.last === null) return null;
  return Object.freeze({
    firstSeq: assertSafeSeq(row.first),
    lastSeq: assertSafeSeq(row.last),
    recordCount: assertSafeSeq(row.count),
  });
}

/**
 * The link this row *should* carry, recomputed from its predecessor — the
 * independent second opinion the whole chain exists to make possible. A
 * genesis row's predecessor is the documented all-zero hash, so the first
 * record needs no special case here either.
 */
export function expectedRecordHash(row: ChainRow, previous: ChainRow | null): Buffer {
  return recordHash(previous === null ? GENESIS_PREV_HASH : previous.recordHash, row.record);
}
