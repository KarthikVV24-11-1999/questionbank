import { GENESIS_PREV_HASH } from './audit-link.js';
import {
  expectedRecordHash,
  readChainPage,
  readChainRowBefore,
  type ChainRow,
  type Queryable,
} from './audit-chain.js';
import { canonicalizeAnchor, verifyAnchorSignature, type AuditAnchor } from './audit-anchor.js';

/**
 * Chain verification and tamper detection (M4-25) — F41, registered in
 * SECURITY-ARCHITECTURE as *"audit hash chain verifies over the last 24
 * hours"* since M0 and unbuilt until now.
 *
 * **It reports where the chain broke, not merely that it did.** "Verification
 * failed" over a table of a hundred thousand records is not an answer anyone
 * can act on; `firstDivergentSeq` names the link, and `reason` names what
 * about it disagreed.
 *
 * **Bounded and streaming.** The window is a sequence range and the scan pulls
 * fixed-size pages, so verification never loads the table — an audit log is
 * the one table guaranteed to grow forever, and a verifier that must fit it in
 * memory is a verifier that stops running the day it matters.
 *
 * **The predecessor of the window's first row is read, not assumed.** A
 * bounded check needs a starting point it did not itself verify; a tamper
 * before the window is outside the claim this makes, and pretending otherwise
 * would be the vacuity F41's non-zero-count assertion exists to reject.
 */

export const VERIFY_PAGE_SIZE = 500;

export type DivergenceReason =
  /** The stored `record_hash` is not what recomputing the link produces — a field was edited. */
  | 'record_hash_mismatch'
  /** The stored `prev_hash` does not name the predecessor's `record_hash` — the chain was re-pointed. */
  | 'prev_hash_mismatch'
  /** `chain_seq` skipped — a link was removed. */
  | 'sequence_gap';

export type VerifyChainResult =
  | { readonly ok: true; readonly recordCount: number; readonly firstSeq: number | null; readonly lastSeq: number | null }
  | {
      readonly ok: false;
      readonly recordCount: number;
      readonly firstDivergentSeq: number;
      readonly reason: DivergenceReason;
      readonly detail: string;
    };

/**
 * Recomputes every link in `[fromSeq, toSeq]` and reports the first that
 * disagrees.
 *
 * The three reasons are distinguished rather than collapsed because they mean
 * different attacks: an edited field, a re-pointed predecessor, and a removed
 * record are three different things to go and look at.
 */
export async function verifyChain(
  pool: Queryable,
  fromSeq: number,
  toSeq: number,
  /** Injectable so a test can prove multi-page traversal without seeding a page's worth of rows. */
  pageSize: number = VERIFY_PAGE_SIZE,
): Promise<VerifyChainResult> {
  let previous: ChainRow | null = null;
  let seeded = false;
  let recordCount = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  let cursor = fromSeq;

  for (;;) {
    const page = await readChainPage(pool, cursor, pageSize, toSeq);
    if (page.length === 0) break;

    for (const row of page) {
      if (!seeded) {
        // The window's starting predecessor, read rather than assumed.
        previous = await readChainRowBefore(pool, row.chainSeq);
        seeded = true;
        firstSeq = row.chainSeq;
      } else if (previous !== null && row.chainSeq !== previous.chainSeq + 1) {
        return {
          ok: false,
          recordCount,
          firstDivergentSeq: row.chainSeq,
          reason: 'sequence_gap',
          detail: `chain_seq jumped from ${previous.chainSeq} to ${row.chainSeq}`,
        };
      }

      const expectedPrev = previous === null ? GENESIS_PREV_HASH : previous.recordHash;
      if (!row.prevHash.equals(expectedPrev)) {
        return {
          ok: false,
          recordCount,
          firstDivergentSeq: row.chainSeq,
          reason: 'prev_hash_mismatch',
          detail:
            previous === null
              ? `chain_seq ${row.chainSeq} opens the chain but does not carry the genesis predecessor`
              : `chain_seq ${row.chainSeq} does not name chain_seq ${previous.chainSeq}'s record_hash`,
        };
      }

      if (!expectedRecordHash(row, previous).equals(row.recordHash)) {
        return {
          ok: false,
          recordCount,
          firstDivergentSeq: row.chainSeq,
          reason: 'record_hash_mismatch',
          detail: `chain_seq ${row.chainSeq} does not hash to its stored record_hash`,
        };
      }

      previous = row;
      lastSeq = row.chainSeq;
      recordCount += 1;
    }

    // A page shorter than the limit is the last one; otherwise continue past
    // the row just consumed rather than re-reading it.
    if (page.length < pageSize) break;
    cursor = page[page.length - 1]!.chainSeq + 1;
  }

  return { ok: true, recordCount, firstSeq, lastSeq };
}

/**
 * The gap between the window's first row and the row before it, checked when
 * `fromSeq` is the true start of the chain. Split out because the seed row is
 * deliberately not verified — see the module header.
 */
export type AnchorDivergenceReason =
  | 'signature_mismatch'
  | 'range_mismatch'
  | 'record_count_mismatch'
  | 'head_hash_mismatch';

export type VerifyAnchorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AnchorDivergenceReason; readonly detail: string };

/**
 * Checks a sealed day against what the chain now says about that day —
 * **independently of link verification**, because the two catch different
 * things.
 *
 * A forged tail appended to an already-anchored day is the case this exists
 * for: the appended records chain correctly, so `verifyChain` is content, and
 * only the anchor notices that the day's range, count and head no longer match
 * what was sealed. The attacker cannot re-sign without `auditAnchorKey`, which
 * is exactly the reduction ADR-0020 claims — and no more than that.
 */
export async function verifyAnchor(
  pool: Queryable,
  key: string,
  anchor: AuditAnchor,
): Promise<VerifyAnchorResult> {
  if (!verifyAnchorSignature(key, anchor)) {
    return {
      ok: false,
      reason: 'signature_mismatch',
      detail: `the anchor for ${anchor.day} is not signed by this key`,
    };
  }

  const found = await pool.query<{
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
    [anchor.day],
  );
  const now = found.rows[0]!;

  if (Number(now.first_seq) !== anchor.firstSeq || Number(now.last_seq) !== anchor.lastSeq) {
    return {
      ok: false,
      reason: 'range_mismatch',
      detail: `${anchor.day} was sealed over [${anchor.firstSeq}, ${anchor.lastSeq}] and now spans [${String(now.first_seq)}, ${String(now.last_seq)}]`,
    };
  }
  if (Number(now.record_count) !== anchor.recordCount) {
    return {
      ok: false,
      reason: 'record_count_mismatch',
      detail: `${anchor.day} was sealed over ${anchor.recordCount} records and now holds ${now.record_count}`,
    };
  }
  if (now.head_hash === null || !now.head_hash.equals(anchor.headHash)) {
    return {
      ok: false,
      reason: 'head_hash_mismatch',
      detail: `${anchor.day}'s head no longer matches the sealed one`,
    };
  }
  return { ok: true };
}

/** Exported so a gate can assert the signed bytes are what it thinks they are. */
export { canonicalizeAnchor };
