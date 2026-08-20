-- The audit hash chain (M4-23, DEC-M4-4 → ADR-0020). F41, registered in
-- SECURITY-ARCHITECTURE since M0 and never built until now.
--
-- **Where.** `platform.audit_record` itself, not a review-only table. A chain
-- covering only review records would leave *publication* records unchained,
-- and publication is the event the chain exists to protect.
--
-- **Why in the database and not the application.** A chain the application
-- computes is bypassed by any other writer, and "any other writer" is the
-- adversary. The link is computed in a `BEFORE INSERT` trigger, so a row
-- inserted by psql, by a migration, or by a compromised second service is
-- chained on exactly the same terms as one written by the app.
--
-- **The canonicalization below is a second implementation of
-- `apps/api/src/platform/persistence/audit-link.ts`**, which is the
-- specification. Two implementations of one rule drift; the mitigation is
-- `audit-chain.integration.spec.ts`, which asserts the two produce
-- byte-identical output over a shared fixture set covering all-populated,
-- every-nullable-NULL, and nullable-at-empty/zero. Any change here without
-- the same change there turns that test red.
--
-- **Coexistence.** `audit_record_append_only` (BEFORE UPDATE OR DELETE →
-- `platform.reject_any_mutation`) already guards this table and is left
-- exactly as it was. The new trigger is BEFORE INSERT, a path that trigger
-- never covered — INSERT is how an audit record is supposed to arrive. The
-- backfill below has to step around the append-only trigger deliberately and
-- does so by disabling it for the length of one statement, inside this
-- transaction, then re-enabling it.
--
-- **No pgcrypto.** Postgres 16 has a built-in `sha256(bytea) -> bytea`.

-- +migrate Up

-- Nullable first: the table may already hold rows, and NOT NULL is set after
-- the backfill has given every one of them a link.
ALTER TABLE platform.audit_record ADD COLUMN chain_seq   bigint;
ALTER TABLE platform.audit_record ADD COLUMN prev_hash   bytea;
ALTER TABLE platform.audit_record ADD COLUMN record_hash bytea;

/*
 * One field of the canonical form: `<octet-length>:<utf8 bytes>`, or `-1:`
 * for NULL. Length-prefixed so the concatenation is injective — without it,
 * ('ab','c') and ('a','bc') would serialize identically and a tamper could
 * move a character across a field boundary undetected. `-1` is a length no
 * real value can produce, which is what keeps NULL distinct from '' and from 0.
 *
 * The length is measured over UTF-8 bytes explicitly rather than with a bare
 * `octet_length(text)`, which would measure in the server encoding and so
 * disagree with `Buffer.byteLength(v, 'utf8')` on a non-UTF8 database.
 */
CREATE OR REPLACE FUNCTION platform.audit_link_field(value text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN value IS NULL THEN '-1:'
    ELSE octet_length(convert_to(value, 'UTF8'))::text || ':' || value
  END
$$;

/*
 * The canonical byte serialization — every column of `platform.audit_record`
 * except the three this migration adds, in the table's own declared column
 * order. `audit_record_id` is included: column defaults are applied before
 * BEFORE INSERT row triggers fire, so `NEW.audit_record_id` is populated
 * here, and including it means the chain binds a record's identity rather
 * than its content alone.
 *
 * `occurred_at` is rendered at microsecond precision. `timestamptz` carries
 * microseconds; a JS `Date` does not, so the verifier reads this column as
 * text through the same rendering rather than letting the driver parse it
 * into a `Date` and silently truncate `.123456` to `.123`.
 *
 * STABLE, not IMMUTABLE: `to_char(timestamp, text)` is itself STABLE, and
 * declaring otherwise would be a claim this function cannot keep.
 */
CREATE OR REPLACE FUNCTION platform.audit_record_canonical(rec platform.audit_record) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT convert_to(
    'v1'
      || platform.audit_link_field(rec.audit_record_id::text)
      || platform.audit_link_field(rec.principal_kind)
      || platform.audit_link_field(rec.principal_id)
      || platform.audit_link_field(rec.action)
      || platform.audit_link_field(rec.target_context)
      || platform.audit_link_field(rec.target_type)
      || platform.audit_link_field(rec.target_id)
      || platform.audit_link_field(rec.target_version::text)
      || platform.audit_link_field(rec.correlation_id)
      || platform.audit_link_field(
           to_char(rec.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      || platform.audit_link_field(rec.justification),
    'UTF8')
$$;

/*
 * The link, computed where the adversary cannot reach around it.
 *
 * `pg_advisory_xact_lock(20260820, 1)` — namespace is this migration's date,
 * key 1 is "the audit chain", of which there is exactly one. The lock is
 * transaction-scoped, so it is released on commit or rollback without any
 * unlock path to forget. It serializes **every** audit insert against every
 * other, which is precisely the cost of a single gapless total order and is
 * stated as such in ADR-0020: `chain_seq` cannot be both gapless and
 * concurrent.
 *
 * Reading the head inside the lock is what makes the sequence gapless.
 * `max(chain_seq)` rather than a sequence object: a sequence hands out
 * numbers that are lost on rollback, and a gap is exactly what M4-25 reports
 * as tampering.
 */
CREATE OR REPLACE FUNCTION platform.audit_record_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(20260820, 1);

  SELECT a.chain_seq, a.record_hash
    INTO head_seq, head_hash
    FROM platform.audit_record a
   ORDER BY a.chain_seq DESC
   LIMIT 1;

  IF head_seq IS NULL THEN
    -- The genesis link. Documented all-zero predecessor, so "the first
    -- record" is not a special case anywhere in the verifier.
    head_seq  := 0;
    head_hash := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  END IF;

  NEW.chain_seq   := head_seq + 1;
  NEW.prev_hash   := head_hash;
  NEW.record_hash := sha256(NEW.prev_hash || platform.audit_record_canonical(NEW));

  RETURN NEW;
END $$;

CREATE TRIGGER audit_record_chain
  BEFORE INSERT ON platform.audit_record
  FOR EACH ROW EXECUTE FUNCTION platform.audit_record_chain();

/*
 * Backfill, so the chain has no pre-history hole. Existing rows are chained
 * in `audit_record_id` order — a UUIDv7 primary key, so that order is
 * insertion order, and the chain's sequence agrees with the history it
 * describes rather than with whatever order a scan happened to return.
 *
 * The append-only trigger has to be stepped around to write the three new
 * columns onto rows that already exist. It is disabled for the length of one
 * statement, inside this transaction, and re-enabled immediately — never left
 * off, and never weakened to permit "just these columns", which would leave a
 * permanent hole in the rule for the sake of a one-time migration.
 */
DO $$
DECLARE
  -- `%ROWTYPE`, not `record`: `platform.audit_record_canonical` takes the
  -- table's composite type, and PL/pgSQL will not cast an anonymous `record`
  -- to it. A loop that never executes hides this — the body only runs when
  -- rows already exist, which is exactly the case the backfill is for.
  rec        platform.audit_record%ROWTYPE;
  prev       bytea := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  next_seq   bigint := 0;
BEGIN
  ALTER TABLE platform.audit_record DISABLE TRIGGER audit_record_append_only;

  FOR rec IN
    SELECT * FROM platform.audit_record WHERE chain_seq IS NULL ORDER BY audit_record_id
  LOOP
    next_seq := next_seq + 1;
    UPDATE platform.audit_record
       SET chain_seq   = next_seq,
           prev_hash   = prev,
           record_hash = sha256(prev || platform.audit_record_canonical(rec))
     WHERE audit_record_id = rec.audit_record_id
     RETURNING record_hash INTO prev;
  END LOOP;

  ALTER TABLE platform.audit_record ENABLE TRIGGER audit_record_append_only;
END $$;

ALTER TABLE platform.audit_record ALTER COLUMN chain_seq   SET NOT NULL;
ALTER TABLE platform.audit_record ALTER COLUMN prev_hash   SET NOT NULL;
ALTER TABLE platform.audit_record ALTER COLUMN record_hash SET NOT NULL;

-- Unique, so a duplicate sequence is refused by the database rather than
-- detected later by the verifier. Gaplessness is the trigger's job; this is
-- the half a constraint can express.
ALTER TABLE platform.audit_record ADD CONSTRAINT audit_record_chain_seq_unique UNIQUE (chain_seq);

-- The verifier reads forward in sequence order over a bounded window.
CREATE INDEX audit_record_chain_seq_idx ON platform.audit_record (chain_seq);

-- No grant changes. §9 rule 11 already withholds UPDATE/DELETE/TRUNCATE on
-- every platform table from `questionbank_app`, and the chain columns must
-- not become the reason that softens (DEC-M4-16 tripwire 2). The application
-- inserts; the trigger chains; nobody updates.

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only. Dropping
-- the trigger before the function it calls, and guarding on the table rather
-- than only on the object name — `DROP TRIGGER IF EXISTS x ON t` still raises
-- when `t` is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'platform' AND table_name = 'audit_record'
  ) THEN
    DROP TRIGGER IF EXISTS audit_record_chain ON platform.audit_record;
    ALTER TABLE platform.audit_record DROP CONSTRAINT IF EXISTS audit_record_chain_seq_unique;
    DROP INDEX IF EXISTS platform.audit_record_chain_seq_idx;
    ALTER TABLE platform.audit_record DROP COLUMN IF EXISTS record_hash;
    ALTER TABLE platform.audit_record DROP COLUMN IF EXISTS prev_hash;
    ALTER TABLE platform.audit_record DROP COLUMN IF EXISTS chain_seq;
  END IF;

  -- Guarded on the schema, not only on the function name:
  -- `DROP FUNCTION IF EXISTS platform.audit_record_canonical(platform.audit_record)`
  -- has to resolve its argument type, and raises when the schema is gone.
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform') THEN
    DROP FUNCTION IF EXISTS platform.audit_record_chain();
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'platform' AND table_name = 'audit_record'
    ) THEN
      DROP FUNCTION IF EXISTS platform.audit_record_canonical(platform.audit_record);
    END IF;
    DROP FUNCTION IF EXISTS platform.audit_link_field(text);
  END IF;
END
$$;
