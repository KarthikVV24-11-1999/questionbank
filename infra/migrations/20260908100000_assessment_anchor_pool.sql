-- The anchor pool (ASSESSMENT-ENGINE §10, M6-15).
--
-- Membership of the pool is a stored fact: a row says that an item version was
-- put there, when, and how many forms it may anchor. Nothing derives it. An
-- anchor whose membership could change by recomputation would drift with its
-- own statistics, and an anchor that drifts is not an anchor.
--
-- The pool is a pool of item VERSIONS, not items (§12: statistics attach to the
-- version a response was sat on). There is deliberately no foreign key to
-- `content.item_version` — §9 rule 3 — so the id is an identifier the
-- application carries and checks against content's catalogue.
--
-- Rotated slowly: a member leaves by having `retired_at` set, once. It is never
-- deleted and never re-added, so the record of which versions anchored which
-- forms stays meaningful. The trigger refuses every other change to a row, and
-- the application role holds no DELETE or TRUNCATE.
--
-- It lives in `assessment` although the context map gives anchors to
-- Psychometrics (ADR-0031).

-- +migrate Up

CREATE TABLE assessment.anchor_pool_member (
  item_version_id  uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  exposure_cap     integer NOT NULL CHECK (exposure_cap > 0),
  added_at         timestamptz NOT NULL,
  retired_at       timestamptz,

  CONSTRAINT anchor_pool_member_retired_after_added CHECK (retired_at IS NULL OR retired_at >= added_at)
);

CREATE INDEX anchor_pool_member_active_idx ON assessment.anchor_pool_member (item_version_id) WHERE retired_at IS NULL;

CREATE OR REPLACE FUNCTION assessment.guard_anchor_pool_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessment_anchor_pool_member_is_never_deleted: %; retire it instead', OLD.item_version_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The only change a row ever takes: leaving the pool, once.
  IF OLD.retired_at IS NOT NULL
     OR NEW.retired_at IS NULL
     OR ROW(NEW.item_version_id, NEW.tenant_id, NEW.exposure_cap, NEW.added_at)
        IS DISTINCT FROM ROW(OLD.item_version_id, OLD.tenant_id, OLD.exposure_cap, OLD.added_at) THEN
    RAISE EXCEPTION 'assessment_anchor_pool_member_only_retires: %', OLD.item_version_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER anchor_pool_member_guarded
  BEFORE UPDATE OR DELETE ON assessment.anchor_pool_member
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_anchor_pool_member();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT, UPDATE ON assessment.anchor_pool_member TO questionbank_app;
    REVOKE DELETE, TRUNCATE ON assessment.anchor_pool_member FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS assessment.anchor_pool_member;
DROP FUNCTION IF EXISTS assessment.guard_anchor_pool_member();
