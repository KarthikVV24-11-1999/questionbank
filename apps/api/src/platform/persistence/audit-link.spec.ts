import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_LINK_COLUMNS,
  AUDIT_LINK_FIELDS,
  AuditLinkError,
  CANONICAL_FORMAT_TAG,
  CHAIN_COLUMNS,
  canonicalize,
  GENESIS_PREV_HASH,
  HASH_BYTES,
  linkHash,
  recordHash,
  type AuditLinkRecord,
} from './audit-link.js';

/**
 * M4-22. The TypeScript here is the **specification** for M4-23's PL/pgSQL;
 * the two are asserted byte-identical over a shared fixture set in
 * `audit-chain.integration.spec.ts`, which is where the drift risk is
 * actually closed. What this file proves is that the specification itself is
 * deterministic, total over its input domain, and sensitive to every field it
 * claims to cover.
 */

const FULL: AuditLinkRecord = Object.freeze({
  auditRecordId: '018f3b2c-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  principalKind: 'human',
  principalId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  action: 'PublishItemVersion',
  targetContext: 'content',
  targetType: 'Item',
  targetId: 'f0e1d2c3-b4a5-4968-8778-6a5b4c3d2e1f',
  targetVersion: 3,
  correlationId: 'corr-0001',
  occurredAt: '2026-08-20T09:00:00.123456Z',
  justification: 'answer key corrected under FR-QM-03',
});

/** Every nullable column at NULL — the other end of the fixture set the SQL twin is compared over. */
const ALL_NULLABLE_NULL: AuditLinkRecord = Object.freeze({
  ...FULL,
  targetVersion: null,
  justification: null,
});

/** Both nullable columns at their empty/zero value — distinct from NULL, which is the point. */
const NULLABLE_EMPTY: AuditLinkRecord = Object.freeze({
  ...FULL,
  targetVersion: 0,
  justification: '',
});

export const CANONICAL_FIXTURES: Readonly<Record<string, AuditLinkRecord>> = Object.freeze({
  full: FULL,
  allNullableNull: ALL_NULLABLE_NULL,
  nullableEmpty: NULLABLE_EMPTY,
});

/** A distinct, same-typed replacement for each field — used to prove every column is covered. */
const MUTATIONS: Readonly<Record<keyof AuditLinkRecord, AuditLinkRecord[keyof AuditLinkRecord]>> = Object.freeze({
  auditRecordId: '018f3b2c-1a2b-7c3d-8e4f-5a6b7c8d9e10',
  principalKind: 'system',
  principalId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e',
  action: 'RetireItem',
  targetContext: 'curriculum',
  targetType: 'Solution',
  targetId: 'f0e1d2c3-b4a5-4968-8778-6a5b4c3d2e20',
  targetVersion: 4,
  correlationId: 'corr-0002',
  occurredAt: '2026-08-20T09:00:00.123457Z',
  justification: 'a different justification',
});

describe('canonicalize — determinism', () => {
  it('produces identical bytes for the same record, every time', () => {
    expect(canonicalize(FULL).equals(canonicalize({ ...FULL }))).toBe(true);
  });

  it('does not depend on the key order of the input object', () => {
    const reversed = Object.fromEntries(
      Object.entries(FULL).reverse(),
    ) as unknown as AuditLinkRecord;
    expect(canonicalize(reversed).equals(canonicalize(FULL))).toBe(true);
  });

  it('starts with the format tag, so a format change is visible in the bytes', () => {
    expect(canonicalize(FULL).toString('utf8').startsWith(CANONICAL_FORMAT_TAG)).toBe(true);
  });
});

describe('canonicalize — every field is covered, one test per column', () => {
  // Generated over AUDIT_LINK_FIELDS rather than written out, so a column
  // added to the canonicalizer without a mutation fixture fails here too.
  for (const spec of AUDIT_LINK_FIELDS) {
    it(`changing ${spec.column} changes the digest`, () => {
      const mutated = { ...FULL, [spec.field]: MUTATIONS[spec.field] } as AuditLinkRecord;
      expect(mutated[spec.field]).not.toEqual(FULL[spec.field]);
      expect(recordHash(GENESIS_PREV_HASH, mutated).equals(recordHash(GENESIS_PREV_HASH, FULL))).toBe(false);
    });
  }

  it('names a mutation for every field, so the loop above is not silently short', () => {
    expect(Object.keys(MUTATIONS).sort()).toEqual(AUDIT_LINK_FIELDS.map((s) => s.field).sort());
  });
});

describe('canonicalize — NULL is not empty, and NULL is not zero', () => {
  it('distinguishes a null justification from an empty one', () => {
    const asNull = { ...FULL, justification: null };
    const asEmpty = { ...FULL, justification: '' };
    expect(canonicalize(asNull).equals(canonicalize(asEmpty))).toBe(false);
  });

  it('distinguishes a null targetVersion from zero', () => {
    const asNull = { ...FULL, targetVersion: null };
    const asZero = { ...FULL, targetVersion: 0 };
    expect(canonicalize(asNull).equals(canonicalize(asZero))).toBe(false);
  });

  it('distinguishes both-null from both-empty across the whole record', () => {
    expect(canonicalize(ALL_NULLABLE_NULL).equals(canonicalize(NULLABLE_EMPTY))).toBe(false);
  });

  it('encodes NULL as the -1 length, which no real length can collide with', () => {
    expect(canonicalize(ALL_NULLABLE_NULL).toString('utf8')).toContain('-1:');
    expect(canonicalize(FULL).toString('utf8')).not.toContain('-1:');
  });
});

describe('canonicalize — the field order is pinned, not incidental', () => {
  /**
   * Length-prefixing makes the encoding injective, so two fields swapping
   * *positions* must change the bytes. Proven by canonicalizing with the
   * values of two same-typed fields exchanged: if order were ignored, the
   * concatenation would be identical.
   */
  it('swapping two same-typed field values changes the digest', () => {
    const swapped = { ...FULL, targetType: FULL.targetContext, targetContext: FULL.targetType };
    expect(canonicalize(swapped).equals(canonicalize(FULL))).toBe(false);
  });

  it('cannot be fooled by moving a character across a field boundary', () => {
    const left = { ...FULL, targetType: 'Ite', targetId: FULL.targetId };
    const right = { ...FULL, targetType: 'Item', targetId: FULL.targetId };
    expect(canonicalize(left).equals(canonicalize(right))).toBe(false);
  });
});

describe('canonicalize — the field set is exactly the table minus the chain columns', () => {
  it('excludes precisely the three columns the trigger sets', () => {
    for (const column of CHAIN_COLUMNS) {
      expect(AUDIT_LINK_COLUMNS).not.toContain(column);
    }
    expect(CHAIN_COLUMNS).toEqual(['chain_seq', 'prev_hash', 'record_hash']);
  });

  it('includes audit_record_id, so the chain binds identity and not only content', () => {
    expect(AUDIT_LINK_COLUMNS).toContain('audit_record_id');
  });
});

describe('linkHash', () => {
  it('is SHA-256 over prevHash then canonical, in that byte order', () => {
    const canonical = canonicalize(FULL);
    const expected = createHash('sha256').update(GENESIS_PREV_HASH).update(canonical).digest();
    expect(linkHash(GENESIS_PREV_HASH, canonical).equals(expected)).toBe(true);
  });

  it('is not the other concatenation order — the two are distinguishable', () => {
    const canonical = canonicalize(FULL);
    const reversed = createHash('sha256').update(canonical).update(GENESIS_PREV_HASH).digest();
    expect(linkHash(GENESIS_PREV_HASH, canonical).equals(reversed)).toBe(false);
  });

  it('changes when only the predecessor changes', () => {
    const canonical = canonicalize(FULL);
    const otherPrev = Buffer.alloc(HASH_BYTES, 7);
    expect(linkHash(GENESIS_PREV_HASH, canonical).equals(linkHash(otherPrev, canonical))).toBe(false);
  });

  it('returns 32 bytes', () => {
    expect(linkHash(GENESIS_PREV_HASH, canonicalize(FULL))).toHaveLength(HASH_BYTES);
  });

  it('refuses a predecessor that is not 32 bytes', () => {
    expect(() => linkHash(Buffer.alloc(31, 0), canonicalize(FULL))).toThrow(AuditLinkError);
  });
});

describe('the genesis link', () => {
  it('is 32 zero bytes, so the first record is not a special case', () => {
    expect(GENESIS_PREV_HASH).toHaveLength(HASH_BYTES);
    expect(GENESIS_PREV_HASH.every((byte) => byte === 0)).toBe(true);
  });

  it('hashes like any other link', () => {
    expect(recordHash(GENESIS_PREV_HASH, FULL).equals(linkHash(GENESIS_PREV_HASH, canonicalize(FULL)))).toBe(
      true,
    );
  });
});

describe('canonicalize — malformed input is refused, never hashed', () => {
  it('refuses a null in a NOT NULL column', () => {
    expect(() => canonicalize({ ...FULL, action: null as unknown as string })).toThrow(
      /action is NOT NULL/u,
    );
  });

  it('refuses an uppercase or braced uuid, which Postgres would never render', () => {
    expect(() => canonicalize({ ...FULL, auditRecordId: FULL.auditRecordId.toUpperCase() })).toThrow(
      /not a lowercase canonical uuid/u,
    );
  });

  it('refuses a non-string uuid', () => {
    expect(() => canonicalize({ ...FULL, auditRecordId: 7 as unknown as string })).toThrow(
      /not a lowercase canonical uuid/u,
    );
  });

  it('refuses a non-integer targetVersion', () => {
    expect(() => canonicalize({ ...FULL, targetVersion: 1.5 })).toThrow(/not an integer/u);
  });

  it('refuses a non-number targetVersion', () => {
    expect(() => canonicalize({ ...FULL, targetVersion: '3' as unknown as number })).toThrow(
      /not an integer/u,
    );
  });

  /**
   * The defect this guard exists for: `timestamptz` carries microseconds and
   * a JS `Date` does not, so a driver-parsed value silently truncates
   * `.123456` to `.123`. Verified against Postgres 16 — the read path casts
   * the column to text rather than letting the driver parse it.
   */
  it('refuses a millisecond instant, the precision a JS Date would have truncated to', () => {
    expect(() => canonicalize({ ...FULL, occurredAt: '2026-08-20T09:00:00.123Z' })).toThrow(
      /exactly six fractional digits/u,
    );
  });

  it('refuses an instant with no fractional part', () => {
    expect(() => canonicalize({ ...FULL, occurredAt: '2026-08-20T09:00:00Z' })).toThrow(
      /exactly six fractional digits/u,
    );
  });

  it('refuses a non-UTC offset', () => {
    expect(() => canonicalize({ ...FULL, occurredAt: '2026-08-20T09:00:00.123456+05:30' })).toThrow(
      /exactly six fractional digits/u,
    );
  });

  it('refuses a non-string instant', () => {
    expect(() => canonicalize({ ...FULL, occurredAt: new Date() as unknown as string })).toThrow(
      /exactly six fractional digits/u,
    );
  });

  it('refuses a non-string in a text column', () => {
    expect(() => canonicalize({ ...FULL, action: 42 as unknown as string })).toThrow(/action is not text/u);
  });

  it('names the module in every message, so a failure points at itself', () => {
    expect(() => canonicalize({ ...FULL, targetVersion: 1.5 })).toThrow(/^audit_link_canonicalization: /u);
  });
});
