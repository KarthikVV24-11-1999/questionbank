-- The daily audit anchor (M4-24, DEC-M4-4 → ADR-0020).
--
-- One row per UTC day, recording the day's sequence range, the head hash at
-- the moment of sealing, and how many records it covers — signed with
-- HMAC-SHA256 in the **application**, under a dedicated `auditAnchorKey`.
--
-- **The key never reaches the database.** That is the whole point of signing
-- in the application: an attacker with database write access can rewrite the
-- chain, but cannot produce a signature over the rewritten head without also
-- holding the process's configuration. The anchor is what turns "database
-- write" into "database write *and* configuration read".
--
-- **This is not notarization, and ADR-0020 says so rather than letting the
-- word "anchor" imply it.** An attacker holding both can rewrite history and
-- re-sign, and nothing here would notice. External witnessing is Tier 3,
-- `Fail — blocked`: no network, no account, no witness. The named successor
-- is publishing `head_hash` to a third-party timestamping authority or a
-- second-party witness — which the `AuditAnchorSealed` outbox event makes a
-- *consumer* rather than a migration.
--
-- Append-only, reusing `platform.reject_any_mutation()` — the same function
-- `audit_record` and M4-21's review tables already use. A sealed day is a
-- historical claim; re-sealing it would be indistinguishable from covering up
-- a rewrite, so the database refuses rather than the application promising.

-- +migrate Up

CREATE TABLE platform.audit_anchor (
  anchor_id    uuid        PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  -- The anchor's real identity. UNIQUE is what makes "one row per UTC day" a
  -- structural fact rather than something the sealer promises — two sealers
  -- racing the same day resolve to one row and one signature.
  day          date        NOT NULL UNIQUE,
  first_seq    bigint      NOT NULL,
  last_seq     bigint      NOT NULL,
  head_hash    bytea       NOT NULL,
  record_count bigint      NOT NULL CHECK (record_count > 0),
  sealed_at    timestamptz NOT NULL,
  signature    bytea       NOT NULL,

  CONSTRAINT audit_anchor_range_is_ordered CHECK (last_seq >= first_seq),
  -- A count that disagrees with its own range is a malformed claim. Not an
  -- equality: the range is contiguous only when the day's records are, and a
  -- day whose sequence range overlaps another day's would be a chain defect
  -- the verifier reports, not something this constraint should mask.
  CONSTRAINT audit_anchor_count_fits_range CHECK (record_count <= last_seq - first_seq + 1)
);

CREATE TRIGGER audit_anchor_append_only
  BEFORE UPDATE OR DELETE ON platform.audit_anchor
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- §9 rule 11. `platform` is append-only by design, so the app role gets
-- SELECT/INSERT and nothing else — matching what the trigger above already
-- refuses at the row level, enforced at the grant level too. Conditional
-- because the role is created by the deployment (M0-24 locally).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_anchor FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only. The
-- trigger goes with the table; `reject_any_mutation` is not dropped, because
-- `audit_record` and the review tables still use it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'platform' AND table_name = 'audit_anchor'
  ) THEN
    DROP TRIGGER IF EXISTS audit_anchor_append_only ON platform.audit_anchor;
    DROP TABLE platform.audit_anchor;
  END IF;
END
$$;
