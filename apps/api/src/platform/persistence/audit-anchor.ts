import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { verifyChain, type DivergenceReason } from './audit-chain-verify.js';

/**
 * The daily audit anchor (M4-24, DEC-M4-4 → ADR-0020).
 *
 * One row per UTC day carrying the day's sequence range, the chain head at the
 * moment of sealing, and the number of records it covers — signed with
 * HMAC-SHA256 under a dedicated `auditAnchorKey`, **never `authSigningKey`**,
 * because one key compromised should not forge both sessions and history.
 *
 * **The key is held in the application and never reaches the database.** That
 * is what the anchor buys: an attacker with database write access can rewrite
 * the chain, but cannot produce a signature over the rewritten head without
 * also holding the process's configuration.
 *
 * ## The limit, stated rather than implied
 *
 * **A key held on the machine that holds the database bounds the attacker to
 * someone holding *both*, rather than someone holding database write access
 * alone. That is a real reduction, and it is not notarization.** An attacker
 * with both can rewrite history and re-sign the anchor, and nothing in this
 * repository would notice. The word "anchor" is not doing more work than that.
 *
 * External witnessing is **Tier 3, `Fail — blocked`** — no network, no
 * account, no witness (DEC-M4-4). **Named successor:** publish `head_hash` to
 * a third-party timestamping authority or a second-party witness. The
 * `AuditAnchorSealed` event is written to `platform.outbox_message` in the
 * same transaction as the seal precisely so that doing so later is a
 * *consumer*, not a migration.
 *
 * ## Idempotence
 *
 * Sealing a day twice is a no-op that returns the existing anchor: never a
 * second row, and **never a re-signature**. A day that could be re-sealed
 * would let a rewrite be laundered by simply signing the new head, which is
 * the one thing the anchor exists to prevent. The `UNIQUE` constraint on `day`
 * makes that structural rather than a promise this module keeps — two sealers
 * racing the same day resolve to one row, and the loser re-reads it.
 */

export const AUDIT_ANCHOR_SEALED_EVENT = 'AuditAnchorSealed';
export const AUDIT_ANCHOR_EVENT_SCHEMA_VERSION = 1;

/** Postgres' `unique_violation`. The race's signature, and nothing else's. */
const UNIQUE_VIOLATION = '23505';

/** The sealer is not a person. `platform.outbox_message.principal_id` is a uuid, so the system principal is the nil uuid. */
const SYSTEM_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';

export interface AuditAnchor {
  readonly anchorId: string;
  /** `YYYY-MM-DD`, UTC. The anchor's real identity — unique, and what the signature binds. */
  readonly day: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly headHash: Buffer;
  readonly recordCount: number;
  /** UTC, microsecond precision — the same rendering the chain uses, for the same reason. */
  readonly sealedAt: string;
  readonly signature: Buffer;
}

export type SealOutcome =
  | { readonly kind: 'sealed'; readonly anchor: AuditAnchor }
  | { readonly kind: 'already_sealed'; readonly anchor: AuditAnchor }
  /**
   * A day with no audit records has nothing to anchor. Refused rather than
   * written: an anchor asserting it covers zero records is exactly the vacuous
   * artifact F41's non-zero-count assertion exists to reject, and storing one
   * would let a verifier report a signed, meaningless day as healthy.
   */
  | { readonly kind: 'no_records'; readonly day: string }
  /**
   * M4-34's one real behaviour: `sealDay` verifies the day's own range with
   * `verifyChain` (M4-25) **before** the insert, inside the same transaction,
   * and refuses to seal a chain that does not verify — an anchor over a chain
   * that does not verify would certify a lie. `firstDivergentSeq` and `reason`
   * are `verifyChain`'s own, passed through unflattened, so a caller acts on
   * the same named link and cause `audit-chain.integration.spec.ts` already
   * proves rather than a re-worded summary.
   */
  | {
      readonly kind: 'verification_failed';
      readonly day: string;
      readonly firstDivergentSeq: number;
      readonly reason: DivergenceReason;
      readonly detail: string;
    };

export class AuditAnchorError extends Error {
  constructor(message: string) {
    super(`audit_anchor: ${message}`);
    this.name = 'AuditAnchorError';
  }
}

/**
 * The signed byte serialization. Length-prefixed and injective on the same
 * argument `audit-link.ts` makes: without it, `first_seq=1,last_seq=23` and
 * `first_seq=12,last_seq=3` would serialize identically.
 *
 * `anchorId` is deliberately **not** signed. It is a surrogate key with no
 * meaning; `day` is the anchor's identity, is `UNIQUE`, and is signed. Signing
 * a value that carries no claim would add bytes and no assurance.
 */
export function canonicalizeAnchor(anchor: Omit<AuditAnchor, 'anchorId' | 'signature'>): Buffer {
  const parts = [
    anchor.day,
    String(anchor.firstSeq),
    String(anchor.lastSeq),
    anchor.headHash.toString('hex'),
    String(anchor.recordCount),
    anchor.sealedAt,
  ];
  const canonical = `anchor-v1${parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('')}`;
  return Buffer.from(canonical, 'utf8');
}

export function signAnchor(key: string, anchor: Omit<AuditAnchor, 'anchorId' | 'signature'>): Buffer {
  return createHmac('sha256', key).update(canonicalizeAnchor(anchor)).digest();
}

/**
 * Constant-time, because a signature check that leaks its comparison position
 * through timing is a signature check an attacker can walk a byte at a time.
 */
export function verifyAnchorSignature(key: string, anchor: AuditAnchor): boolean {
  const expected = signAnchor(key, anchor);
  return expected.length === anchor.signature.length && timingSafeEqual(expected, anchor.signature);
}

interface AnchorRow {
  readonly anchor_id: string;
  readonly day: string;
  readonly first_seq: string;
  readonly last_seq: string;
  readonly head_hash: Buffer;
  readonly record_count: string;
  readonly sealed_at: string;
  readonly signature: Buffer;
}

/** `sealed_at` and `day` are read as text for the same reason the chain does: the driver would reinterpret both. */
const SELECT_ANCHOR = `
  anchor_id::text AS anchor_id,
  to_char(day, 'YYYY-MM-DD') AS day,
  first_seq::text AS first_seq,
  last_seq::text  AS last_seq,
  head_hash,
  record_count::text AS record_count,
  to_char(sealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed_at,
  signature
`;

function toAnchor(row: AnchorRow): AuditAnchor {
  return Object.freeze({
    anchorId: row.anchor_id,
    day: row.day,
    firstSeq: Number(row.first_seq),
    lastSeq: Number(row.last_seq),
    headHash: row.head_hash,
    recordCount: Number(row.record_count),
    sealedAt: row.sealed_at,
    signature: row.signature,
  });
}

async function findAnchorWith(client: Pool | PoolClient, day: string): Promise<AuditAnchor | null> {
  const found = await client.query<AnchorRow>(
    `SELECT ${SELECT_ANCHOR} FROM platform.audit_anchor WHERE day = $1::date`,
    [day],
  );
  return found.rowCount === 0 ? null : toAnchor(found.rows[0]!);
}

export async function findAnchor(pool: Pool, day: string): Promise<AuditAnchor | null> {
  return findAnchorWith(pool, day);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/**
 * Seals one UTC day. Idempotent, transactional, and it emits
 * `AuditAnchorSealed` to the outbox **in the same transaction** — a seal that
 * committed without its event would leave an external witness permanently
 * behind with nothing to say it had been.
 */
export async function sealDay(
  pool: Pool,
  key: string,
  day: string,
  sealedAt: string,
): Promise<SealOutcome> {
  if (!DAY.test(day)) throw new AuditAnchorError(`day "${day}" is not YYYY-MM-DD`);
  if (!MICROSECOND_INSTANT.test(sealedAt)) {
    throw new AuditAnchorError(`sealedAt "${sealedAt}" is not a UTC instant with six fractional digits`);
  }

  const existing = await findAnchor(pool, day);
  if (existing !== null) return { kind: 'already_sealed', anchor: existing };

  /*
   * Range, count and head in **one** query. Two queries would leave a window
   * in which the row named by `max(chain_seq)` was not the row read back, and
   * closing that window with an "impossible" guard would put a branch in a
   * module the 100% rule covers that no test could ever reach.
   */
  const day_ = await pool.query<{
    first_seq: string | null;
    last_seq: string | null;
    record_count: string;
    head_hash: Buffer | null;
  }>(
    `WITH day_rows AS (
       SELECT chain_seq, record_hash FROM platform.audit_record
        WHERE occurred_at >= $1::date AND occurred_at < ($1::date + interval '1 day')
     )
     SELECT min(chain_seq)::text AS first_seq,
            max(chain_seq)::text AS last_seq,
            count(*)::text       AS record_count,
            (SELECT record_hash FROM day_rows ORDER BY chain_seq DESC LIMIT 1) AS head_hash
       FROM day_rows`,
    [day],
  );
  const summary = day_.rows[0]!;
  if (summary.first_seq === null) return { kind: 'no_records', day };

  const unsigned = {
    day,
    firstSeq: Number(summary.first_seq),
    lastSeq: Number(summary.last_seq),
    // Non-null exactly when `first_seq` is: both come from the same non-empty
    // `day_rows`, in the same snapshot.
    headHash: summary.head_hash!,
    recordCount: Number(summary.record_count),
    sealedAt,
  };
  const signature = signAnchor(key, unsigned);

  /*
   * No `finally`. The release below runs on both paths because the catch
   * assigns rather than rethrows, and the rethrow happens after the client is
   * back in the pool. A `finally` here would carry an abrupt-completion path
   * that nothing can reach — untestable code in a module the 100% rule covers.
   * Same shape, and the same reason, as `item.repository.ts`'s `save`.
   */
  const client = await pool.connect();
  let outcome: SealOutcome | { readonly failure: unknown };
  try {
    await client.query('BEGIN');

    /*
     * Verify before sealing, inside this same transaction, over exactly the
     * range about to be anchored — the one behavioural gap this task closes.
     * An anchor over a chain that does not verify certifies a lie, so a
     * divergence here refuses the seal outright: no row, no signature, no
     * event — `ROLLBACK`, the same tail every other outcome shares below.
     */
    const verified = await verifyChain(client, unsigned.firstSeq, unsigned.lastSeq);
    if (!verified.ok) {
      await client.query('ROLLBACK');
      outcome = {
        kind: 'verification_failed',
        day,
        firstDivergentSeq: verified.firstDivergentSeq,
        reason: verified.reason,
        detail: verified.detail,
      };
    } else {
      /*
       * A plain `INSERT`, not `ON CONFLICT DO NOTHING`. `DO NOTHING` does not
       * block on a *uncommitted* conflicting row — it skips it — so the re-read
       * that follows could miss a winner still in flight and see nothing at all.
       * A plain insert blocks until that transaction commits or aborts, so by
       * the time the unique violation is raised the winner is committed and
       * visible. The difference only shows under a real race, which is where it
       * matters.
       */
      const inserted = await client.query<AnchorRow>(
        `INSERT INTO platform.audit_anchor
           (day, first_seq, last_seq, head_hash, record_count, sealed_at, signature)
         VALUES ($1::date, $2, $3, $4, $5, $6::timestamptz, $7)
         RETURNING ${SELECT_ANCHOR}`,
        [
          day,
          unsigned.firstSeq,
          unsigned.lastSeq,
          unsigned.headHash,
          unsigned.recordCount,
          sealedAt,
          signature,
        ],
      );

      const anchor = toAnchor(inserted.rows[0]!);

      await client.query(
        `INSERT INTO platform.outbox_message
           (event_type, schema_version, aggregate_type, aggregate_id, payload, payload_schema_version,
            principal_kind, principal_id, correlation_id, occurred_at)
         VALUES ($1, $2, 'AuditAnchor', $3, $4, 1, 'system', $5, $6, $7::timestamptz)`,
        [
          AUDIT_ANCHOR_SEALED_EVENT,
          AUDIT_ANCHOR_EVENT_SCHEMA_VERSION,
          anchor.anchorId,
          // Identifiers and the head hash only — an outbox drains to analytics
          // (P4/D17), and the signature is not something a consumer needs to
          // hold in order to fetch and witness a head.
          JSON.stringify({
            anchorId: anchor.anchorId,
            day: anchor.day,
            firstSeq: anchor.firstSeq,
            lastSeq: anchor.lastSeq,
            headHash: anchor.headHash.toString('hex'),
            recordCount: anchor.recordCount,
          }),
          SYSTEM_PRINCIPAL_ID,
          `audit-anchor-${day}`,
          sealedAt,
        ],
      );

      await client.query('COMMIT');
      outcome = { kind: 'sealed', anchor };
    }
  } catch (error) {
    await client.query('ROLLBACK');

    /*
     * The race, and only the race. Another sealer got this day first; because
     * the insert above blocks rather than skipping, that winner is committed
     * and visible by the time this line runs, so the re-read cannot come back
     * empty. Every other failure is carried out and rethrown — a seal that
     * could not be written must not look like a seal that already existed.
     */
    outcome =
      (error as { code?: string }).code === UNIQUE_VIOLATION
        ? { kind: 'already_sealed', anchor: (await findAnchor(pool, day))! }
        : { failure: error };
  }

  client.release();
  if ('failure' in outcome) throw outcome.failure;
  return outcome;
}
