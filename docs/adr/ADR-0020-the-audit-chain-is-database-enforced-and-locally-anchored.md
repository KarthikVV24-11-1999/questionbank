# ADR-0020 — The audit chain is database-enforced and locally anchored
Status: Accepted
Date: 2026-08-20

## Context

`platform.audit_record` has existed since M0-07: one table serving all three contexts,
append-only by trigger, with no `UPDATE`/`DELETE`/`TRUNCATE` grant for `questionbank_app`. It
records who published what, who approved it, and why. It has never had a hash chain.

F41 is registered in [SECURITY-ARCHITECTURE](../SECURITY-ARCHITECTURE.md) as *"audit hash chain
verifies over the last 24 hours"* and has been unbuilt since it was written. Append-only by
trigger answers "can the application quietly edit history" — it does not answer "can anyone",
because a trigger is disabled by whoever owns the table, and the row it protected leaves no
evidence that it changed. A chain is what turns an undetectable edit into a detectable one.

This ADR records four decisions that M4-22 through M4-25 implement, and one limit that the
implementation cannot lift.

## Decision

### 1. The chain covers `platform.audit_record`, not a review-specific table

M4 is the governance milestone, so the tempting scope is "chain the review decisions." That would
be the wrong table. A chain covering only review records leaves **publication** records unchained,
and publication — the moment an item becomes something a student is scored against — is the event
the chain exists to protect. The audit table already spans content, curriculum and scoring, so
chaining it covers every context's compliance record at once and touches no context's schema.

### 2. The link is computed in the database, not in the application

`record_hash` is set by a `BEFORE INSERT` trigger, `platform.audit_record_chain()`.

A chain the application computes is bypassed by any other writer, and *any other writer* is
precisely the adversary this defends against. A row inserted by `psql`, by a migration, by a
second service, or by a compromised process that skips the ORM is chained on exactly the same
terms as one written through `PostgresAuditRecorder`. There is no code path that produces an
unchained row, because the code path is not what does the chaining.

The trigger takes `pg_advisory_xact_lock(20260820, 1)` and reads the head inside the lock.

**The cost is stated rather than hidden: this serializes every audit insert against every other.**
A single gapless total order and concurrent assignment are not simultaneously available, and
gaplessness was chosen because a gap is one of the four tamper classes M4-25 detects — a chain
whose sequence is allowed to skip cannot distinguish a deleted record from a rolled-back
transaction. A sequence object would have been concurrent and would have produced exactly that
ambiguity, so `max(chain_seq) + 1` under a lock is the deliberate choice.

### 3. The canonical form, stated mechanically

    canonical(row) = every column of platform.audit_record
                     except the three the trigger itself sets:
                     chain_seq, prev_hash, record_hash

Stated as a mechanical rule rather than as "the semantic columns", which is a judgement each
reader makes again and gets differently. The three exclusions are excluded because chaining over a
value the trigger is in the middle of computing is circular — not because they are uninteresting.

**`audit_record_id` is included**, though it is a defaulted column. Postgres applies column
defaults *before* `BEFORE INSERT` row triggers fire, so `NEW.audit_record_id` is populated and
reproducible on both sides; including it means the chain binds a record's *identity* and not only
its content, so a row whose primary key is rewritten fails verification.

`audit-link.ts` exports `AUDIT_LINK_COLUMNS`, and an integration test asserts it equals
`information_schema`'s column set for the table minus the three chain columns. A column added by a
later migration that nobody adds to the canonicalizer turns that test red rather than silently
falling out of chain coverage — which would otherwise leave every other test in the suite green.

**The layout is normative:**

    record_hash = SHA-256( prev_hash ‖ canonical(row) )

The fixed-length 32-byte predecessor comes **first**, the variable-length canonical form last, so
the boundary between the two inputs is unambiguous without a separator. `linkHash(prevHash,
canonicalBytes)` takes its arguments in that same order deliberately: a signature whose arguments
run opposite to the bytes they produce is how a later edit flips the construction silently.

The genesis predecessor is 32 zero bytes, so "the first record" is not a special case anywhere in
the verifier.

Encoding is length-prefixed and therefore injective: each field contributes
`<octet-length>:<utf8 bytes>`, and `NULL` contributes `-1:`, a length no real value can produce.
Without the prefix, `("ab","c")` and `("a","bc")` serialize identically and a tamper could move a
character across a field boundary undetected; without the `-1` sentinel, `NULL` and `''` — and
`NULL` and `0` — would be indistinguishable, and a NULL/empty swap would be an undetected edit.

**`occurred_at` is canonicalized as microsecond-precision UTC text.** `timestamptz` carries
microseconds; a JavaScript `Date` does not. Verified against Postgres 16 rather than assumed:
reading the column through the driver truncates `.123456` to `.123`, so a TypeScript verifier that
accepted a `Date` would recompute a different hash than the trigger stored, for any record written
with sub-millisecond precision. The read path casts the column to text with the same `to_char`
format the trigger uses, and `canonicalize` refuses any other shape rather than hashing it.

### 4. Two implementations, and a test that compares them

The canonicalization exists twice: `apps/api/src/platform/persistence/audit-link.ts` is the
specification, and the migration's PL/pgSQL is what actually runs. This is a deliberate
duplication — decision 2 requires the hash to be computed in the database, and decision 4 of
M4-25 requires an independent recomputation outside it, so a single implementation is not
available.

Two implementations of one rule drift. This project has been bitten three times. The mitigation is
not a comment asking people to be careful: `audit-chain.integration.spec.ts` asserts the two
produce **byte-identical** output over a fixture set chosen to break a naive canonicalizer — all
columns populated, every nullable column `NULL`, both nullable columns at their empty/zero value,
multi-byte UTF-8, and microsecond boundaries.

## The limit, stated rather than implied

The daily anchor (M4-24) is one `platform.audit_anchor` row per UTC day carrying the day's
sequence range, head hash and record count, signed with HMAC-SHA256 under a dedicated
`auditAnchorKey` — never `authSigningKey`, because one key compromised should not forge both
sessions and history. The key is read through the typed config module and never reaches the
database; the anchor is signed in the application.

**This is not notarization, and the ADR says so rather than letting the word "anchor" imply it.**

A key held on the machine that holds the database bounds the attacker to *someone with both
database write access and process configuration access*, rather than *someone with database write
access*. That is a real reduction and it is the honest description of what this buys. It is not a
proof to a third party: an attacker with both can rewrite history and re-sign the anchor, and
nothing in this repository would notice.

**External witnessing is Tier 3, `Fail — blocked`.** No network, no account, no witness (DEC-M4-4).
The named successor: publish `head_hash` to a third-party timestamping authority or a second-party
witness. The `AuditAnchorSealed` event is written to `platform.outbox_message` in the same
transaction as the seal precisely so that publishing to such a witness later is a **consumer**, not
a migration.

## Consequences

- Every audit insert serializes on one advisory lock. Accepted, per decision 2.
- The append-only trigger and the grant revocation are unchanged; the app role gains no `UPDATE`
  (DEC-M4-16 tripwire 2). The backfill disables the append-only trigger for the length of one
  statement inside the migration's transaction and re-enables it, rather than weakening the rule
  permanently to accommodate a one-time migration.
- Existing audit rows are backfilled in `audit_record_id` order — a UUIDv7 primary key, so that is
  insertion order — leaving no pre-history hole for the verifier to report as a gap.
- `chain_seq` is `bigint`; the read path refuses a value outside JavaScript's safe integer range
  rather than rounding it.

## Correction to DEC-M4-4

M4's DEC-M4-4 states the link as
`record_hash = sha256(canonical(row) ‖ prev_hash)`, and M4-22's own acceptance criterion states the
opposite order, `SHA-256 over prevHash ‖ canonical`. The two lines contradict each other. **M4-22's
order governs** and is normative above; DEC-M4-4's line carries a dated correction note pointing
here. Both orders are cryptographically sound — what mattered was fixing one, because the whole
point of decision 4 is that two implementations produce identical bytes.
