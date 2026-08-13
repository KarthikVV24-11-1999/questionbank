-- One audit table serving three contexts (M0-07). Content, curriculum and
-- scoring each declare their own `AuditRecord`/`AuditRecorder` port
-- independently (§9 rule 1 — no context reaches into another's application
-- layer), and each has said since M1/M2/M3 "D4 replaces the in-memory
-- implementation with a durable one." This is that durable implementation,
-- one physical table rather than three, distinguished by `target_context`.
--
-- Platform-owned, so no foreign key points into a context schema (F2) —
-- `target_id` names a row in another schema by value, never by reference.
--
-- Append-only from the moment a row exists, on the same argument
-- scoring_immutability.sql makes for `item_outcome`/`section_score`: an
-- audit record has no draft state to justify an UPDATE grant, so the
-- trigger rejects every mutation rather than permitting one narrow case.

-- +migrate Up

CREATE TABLE platform.audit_record (
  audit_record_id  uuid        PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  principal_kind   text        NOT NULL CHECK (principal_kind IN ('human', 'ai_agent', 'system')),
  principal_id     text        NOT NULL CHECK (length(btrim(principal_id)) > 0),
  action           text        NOT NULL CHECK (length(btrim(action)) > 0),
  target_context   text        NOT NULL CHECK (target_context IN ('content', 'curriculum', 'scoring')),
  target_type      text        NOT NULL CHECK (length(btrim(target_type)) > 0),
  target_id        text        NOT NULL CHECK (length(btrim(target_id)) > 0),
  -- Curriculum's AuditRecord names a version; content's and scoring's do not.
  target_version   integer,
  correlation_id   text        NOT NULL CHECK (length(btrim(correlation_id)) > 0),
  occurred_at      timestamptz NOT NULL,
  -- Content's AuditRecord alone carries a justification (INV-02).
  justification    text
);

-- The lookup InMemoryAuditRecorder.entriesFor(targetId) already supports.
CREATE INDEX audit_record_target_idx ON platform.audit_record (target_context, target_id);

CREATE OR REPLACE FUNCTION platform.reject_any_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_record_is_append_only: % is append-only and rejects %',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER audit_record_append_only
  BEFORE UPDATE OR DELETE ON platform.audit_record
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- §9 rule 11: the application role holds no UPDATE/DELETE/TRUNCATE grant on
-- an append-only table, closing the TRUNCATE path a row trigger cannot see.
-- Conditional because the role is created by the deployment (M0-24 locally);
-- a local database without it yet is not a broken migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_record FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP TRIGGER IF EXISTS audit_record_append_only ON platform.audit_record;
DROP FUNCTION IF EXISTS platform.reject_any_mutation();
DROP TABLE IF EXISTS platform.audit_record;
