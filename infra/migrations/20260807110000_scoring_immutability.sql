-- Score records are append-only, enforced at the database (INV-11, D3).
--
-- A score is an interpretation of an attempt, and correcting one produces a
-- successor rather than an edit. Triggers are not role-aware, so a direct psql
-- UPDATE is rejected exactly as an ORM UPDATE is — the M1 standard.
--
-- Row triggers do not fire on TRUNCATE. That path is closed by withholding the
-- grant from the application role (§9 rule 11), below.

-- +migrate Up

-- A score record may change in exactly one way: a current record standing down
-- so its successor can take over. Nothing else, and never back again.
CREATE OR REPLACE FUNCTION scoring.reject_score_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'score_record_is_append_only: a score record is never deleted; every generation is retained'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.is_current AND NOT NEW.is_current
     AND to_jsonb(NEW) - 'is_current' = to_jsonb(OLD) - 'is_current' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'score_record_is_append_only: only is_current may change, and only from true to false'
    USING ERRCODE = 'restrict_violation';
END $$;

-- Outcomes and section scores belong to a record that cannot change, so they
-- cannot change either. There is no permitted update at all.
CREATE OR REPLACE FUNCTION scoring.reject_any_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'score_detail_is_append_only: % is append-only and rejects %',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER score_record_append_only
  BEFORE UPDATE OR DELETE ON scoring.score_record
  FOR EACH ROW EXECUTE FUNCTION scoring.reject_score_record_mutation();

CREATE TRIGGER item_outcome_append_only
  BEFORE UPDATE OR DELETE ON scoring.item_outcome
  FOR EACH ROW EXECUTE FUNCTION scoring.reject_any_mutation();

CREATE TRIGGER section_score_append_only
  BEFORE UPDATE OR DELETE ON scoring.section_score
  FOR EACH ROW EXECUTE FUNCTION scoring.reject_any_mutation();

-- §9 rule 11: the application role holds no UPDATE or DELETE grant on an
-- append-only table, closing the TRUNCATE path the triggers cannot see. The
-- role is created by the deployment, so this is conditional rather than
-- assumed — a local database without it is not a broken migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON scoring.item_outcome FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON scoring.section_score FROM questionbank_app;
    REVOKE DELETE, TRUNCATE ON scoring.score_record FROM questionbank_app;
    -- score_record keeps UPDATE so a successor can stand its predecessor down;
    -- the trigger above is what limits that to the is_current flip.
  END IF;
END $$;

-- +migrate Down

DROP TRIGGER IF EXISTS section_score_append_only ON scoring.section_score;
DROP TRIGGER IF EXISTS item_outcome_append_only ON scoring.item_outcome;
DROP TRIGGER IF EXISTS score_record_append_only ON scoring.score_record;
DROP FUNCTION IF EXISTS scoring.reject_any_mutation();
DROP FUNCTION IF EXISTS scoring.reject_score_record_mutation();
