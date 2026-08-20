import { createHash } from 'node:crypto';

/**
 * The audit hash chain's link function (M4-22, DEC-M4-4 → ADR-0020) — the
 * **pure** half, testable without a database.
 *
 * **This module is the specification.** M4-23 implements the same
 * canonicalization a second time, in PL/pgSQL, because the chain has to be
 * computed where the adversary cannot reach around it. Two implementations of
 * one rule drift; the mitigation is not a comment asking people to be careful
 * but `audit-chain.integration.spec.ts`, which asserts the two produce
 * byte-identical output over a shared fixture set.
 *
 * ## What is canonicalized
 *
 * **Every column of `platform.audit_record` except the three the trigger
 * itself sets** — `chain_seq`, `prev_hash`, `record_hash`. Stated
 * mechanically on purpose: "the semantic columns" is a judgement each reader
 * makes again, and a column that falls out of chain coverage by inattention
 * leaves every other test green. `auditRecordId` is **in** the set, so the
 * chain binds a record's identity and not merely its content; it is a
 * defaulted column, but Postgres applies column defaults *before* `BEFORE
 * INSERT` row triggers fire, so `NEW.audit_record_id` is populated and
 * reproducible on both sides. The three excluded columns are excluded because
 * chaining over a value the trigger is in the middle of computing is
 * circular, not because they are uninteresting.
 *
 * `AUDIT_LINK_COLUMNS` is exported so a catalogue test can assert this list
 * equals `platform.audit_record`'s real column set minus `CHAIN_COLUMNS`. A
 * column added by a later migration that nobody adds here turns that test
 * red.
 *
 * ## The encoding
 *
 * Length-prefixed and therefore injective: each field contributes
 * `<octet-length>:<utf8 bytes>`, and a `NULL` contributes `-1:` — which no
 * real length can collide with, so `NULL` and `''` are distinguishable, as
 * are `NULL` and `0`. Without the length prefix, `("ab", "c")` and
 * `("a", "bc")` would serialize identically and a tamper could move a
 * character across a field boundary undetected.
 *
 * Every rendering is fixed and locale-independent: a uuid as Postgres'
 * lowercase canonical text, an integer as bare decimal digits, an instant as
 * UTC with exactly six fractional digits. `occurredAt` is accepted **as that
 * string, never as a `Date`** — `timestamptz` carries microseconds and a JS
 * `Date` cannot, so a driver-parsed `Date` silently truncates `.123456` to
 * `.123` and the recomputed hash would differ from the stored one for any
 * record written with sub-millisecond precision. Verified against Postgres 16,
 * not assumed. The read path casts the column to text; this module never
 * converts one.
 *
 * ## The link
 *
 * `linkHash(prevHash, canonical)` = `SHA-256(prevHash ‖ canonical)` — the
 * fixed-length 32-byte prefix first, the variable-length canonical form last,
 * so the boundary between the two inputs is unambiguous. The argument order
 * matches the concatenation order deliberately: a signature whose arguments
 * run opposite to the bytes is how a later edit flips it silently.
 *
 * The genesis link uses an all-zero 32-byte `prevHash`, so "the first record"
 * is not a special case anywhere in the verifier.
 */

/** The three columns the `BEFORE INSERT` trigger sets. Never canonicalized — chaining over them is circular. */
export const CHAIN_COLUMNS = ['chain_seq', 'prev_hash', 'record_hash'] as const;

/** The canonical form's version tag. A format change bumps this and every stored hash becomes v1 history. */
export const CANONICAL_FORMAT_TAG = 'v1';

/** SHA-256 is 32 bytes; the genesis predecessor is 32 zero bytes. */
export const HASH_BYTES = 32;
export const GENESIS_PREV_HASH: Buffer = Buffer.alloc(HASH_BYTES, 0);

export interface AuditLinkRecord {
  readonly auditRecordId: string;
  readonly principalKind: string;
  readonly principalId: string;
  readonly action: string;
  readonly targetContext: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetVersion: number | null;
  readonly correlationId: string;
  /** UTC, microsecond precision, exactly `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Never a `Date` — see the module header. */
  readonly occurredAt: string;
  readonly justification: string | null;
}

type FieldKind = 'uuid' | 'text' | 'int' | 'instant';

interface FieldSpec {
  readonly field: keyof AuditLinkRecord;
  readonly column: string;
  readonly kind: FieldKind;
  readonly nullable: boolean;
}

/**
 * The order is pinned, not incidental: it is `platform.audit_record`'s own
 * declared column order, and `audit-link.spec.ts` asserts that permuting two
 * entries changes the digest — so a reordering cannot pass unnoticed.
 */
export const AUDIT_LINK_FIELDS: readonly FieldSpec[] = Object.freeze([
  { field: 'auditRecordId', column: 'audit_record_id', kind: 'uuid', nullable: false },
  { field: 'principalKind', column: 'principal_kind', kind: 'text', nullable: false },
  { field: 'principalId', column: 'principal_id', kind: 'text', nullable: false },
  { field: 'action', column: 'action', kind: 'text', nullable: false },
  { field: 'targetContext', column: 'target_context', kind: 'text', nullable: false },
  { field: 'targetType', column: 'target_type', kind: 'text', nullable: false },
  { field: 'targetId', column: 'target_id', kind: 'text', nullable: false },
  { field: 'targetVersion', column: 'target_version', kind: 'int', nullable: true },
  { field: 'correlationId', column: 'correlation_id', kind: 'text', nullable: false },
  { field: 'occurredAt', column: 'occurred_at', kind: 'instant', nullable: false },
  { field: 'justification', column: 'justification', kind: 'text', nullable: true },
] as const satisfies readonly FieldSpec[]);

/** The columns this module canonicalizes, in order — the catalogue test's left-hand side. */
export const AUDIT_LINK_COLUMNS: readonly string[] = Object.freeze(
  AUDIT_LINK_FIELDS.map((spec) => spec.column),
);

/** Postgres renders `uuid::text` lowercase and hyphenated; anything else would not round-trip. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Exactly six fractional digits — `to_char(…, 'US')`'s output, zero-padded, never truncated. */
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/**
 * Malformed input is refused rather than hashed. A canonicalizer that
 * silently accepts a float `targetVersion` or a millisecond `occurredAt`
 * produces a digest the SQL side cannot reproduce — a chain that fails later,
 * on data, with nothing to point at. `platform/` is infrastructure, the one
 * layer permitted to throw (§8).
 */
export class AuditLinkError extends Error {
  constructor(message: string) {
    super(`audit_link_canonicalization: ${message}`);
    this.name = 'AuditLinkError';
  }
}

function render(spec: FieldSpec, value: AuditLinkRecord[keyof AuditLinkRecord]): string | null {
  if (value === null) {
    if (!spec.nullable) {
      throw new AuditLinkError(`${spec.column} is NOT NULL and was null`);
    }
    return null;
  }

  switch (spec.kind) {
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_TEXT.test(value)) {
        throw new AuditLinkError(`${spec.column} is not a lowercase canonical uuid`);
      }
      return value;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new AuditLinkError(`${spec.column} is not an integer`);
      }
      // Bare decimal digits: `String(n)` is locale-independent, unlike `toLocaleString`.
      return String(value);
    }
    case 'instant': {
      if (typeof value !== 'string' || !MICROSECOND_INSTANT.test(value)) {
        throw new AuditLinkError(`${spec.column} is not a UTC instant with exactly six fractional digits`);
      }
      return value;
    }
    case 'text': {
      if (typeof value !== 'string') {
        throw new AuditLinkError(`${spec.column} is not text`);
      }
      return value;
    }
  }
}

/** `-1:` for NULL, `<octet-length>:<bytes>` otherwise — injective, so no tamper can move bytes across a field boundary. */
function encodeField(rendered: string | null): string {
  return rendered === null ? '-1:' : `${Buffer.byteLength(rendered, 'utf8')}:${rendered}`;
}

/**
 * The deterministic byte serialization every link is computed over. Pure:
 * same record in, same bytes out, on any machine, in any locale, at any time.
 */
export function canonicalize(record: AuditLinkRecord): Buffer {
  let canonical = CANONICAL_FORMAT_TAG;
  for (const spec of AUDIT_LINK_FIELDS) {
    canonical += encodeField(render(spec, record[spec.field]));
  }
  return Buffer.from(canonical, 'utf8');
}

/**
 * `SHA-256(prevHash ‖ canonical)`. `prevHash` is the fixed-length half and
 * comes first; the argument order matches the byte order on purpose.
 */
export function linkHash(prevHash: Buffer, canonicalBytes: Buffer): Buffer {
  if (prevHash.length !== HASH_BYTES) {
    throw new AuditLinkError(`prevHash must be exactly ${HASH_BYTES} bytes`);
  }
  return createHash('sha256').update(prevHash).update(canonicalBytes).digest();
}

/** The whole link in one call — what both the trigger's SQL twin and the verifier compute. */
export function recordHash(prevHash: Buffer, record: AuditLinkRecord): Buffer {
  return linkHash(prevHash, canonicalize(record));
}
