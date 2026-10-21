-- Publication, held at the database (D-006, ASSESSMENT-ENGINE §6 and §10, M6-19).
--
-- The domain refuses to publish a form that is below the anchor floor, and the
-- repository's publication transaction writes the ledger and changes the state
-- together. This migration makes the same three facts true of the database
-- itself, so a writer that bypasses both — a script, a console, a second
-- service — cannot publish a form that is not fit to be:
--
--   * a form can only be inserted as a draft;
--   * a draft becomes published only when its exposure ledger holds a row for
--     every slot, its anchor flags agree with the anchor pool as it stands, and
--     at least 15% of its slots are anchors (F50);
--   * its blueprint report says it was satisfied.
--
-- **This is a second implementation of the anchor floor.** The domain holds
-- the rule as `meetsAnchorFloor`; here it is `assessment.anchor_floor_met`,
-- and an integration spec holds the two to the same answer over every form
-- size and anchor count up to forty.
--
-- Immutability itself — that nothing about a published form may change — is
-- the earlier migration's `form_immutable_once_published` and its children's
-- triggers; nothing here relaxes them.

-- +migrate Up

CREATE OR REPLACE FUNCTION assessment.anchor_floor_met(anchors integer, total integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT total > 0 AND anchors * 100 >= total * 15
$$;

CREATE OR REPLACE FUNCTION assessment.require_draft_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'draft' THEN
    RAISE EXCEPTION 'assessment_form_is_born_a_draft: form % cannot be inserted as %; publish a draft', NEW.form_id, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER form_born_a_draft
  BEFORE INSERT ON assessment.form
  FOR EACH ROW EXECUTE FUNCTION assessment.require_draft_on_insert();

CREATE OR REPLACE FUNCTION assessment.guard_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  slot_count integer;
  anchor_count integer;
  disagreeing integer;
  ledger_count integer;
BEGIN
  IF NEW.blueprint_conformance ->> 'satisfied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'assessment_publication_requires_conformance: form % does not satisfy its blueprint', NEW.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE s.is_anchor),
         count(*) FILTER (WHERE s.is_anchor <> EXISTS (
           SELECT 1 FROM assessment.anchor_pool_member m
            WHERE m.item_version_id = s.item_version_id AND m.retired_at IS NULL))
    INTO slot_count, anchor_count, disagreeing
    FROM assessment.form_slot s WHERE s.form_id = NEW.form_id;

  IF disagreeing > 0 THEN
    RAISE EXCEPTION 'assessment_publication_anchor_flag_disagrees_with_pool: % slot(s) of form % disagree with the anchor pool', disagreeing, NEW.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT assessment.anchor_floor_met(anchor_count, slot_count) THEN
    RAISE EXCEPTION 'assessment_publication_anchor_floor: form % has % anchor(s) in % slot(s); at least 15%% are required (F50)', NEW.form_id, anchor_count, slot_count
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO ledger_count FROM assessment.exposure_ledger_entry WHERE form_id = NEW.form_id;
  IF ledger_count <> slot_count THEN
    RAISE EXCEPTION 'assessment_publication_requires_ledger: form % has % ledger row(s) for % slot(s)', NEW.form_id, ledger_count, slot_count
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER form_publication_guarded
  BEFORE UPDATE ON assessment.form
  FOR EACH ROW
  WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL)
  EXECUTE FUNCTION assessment.guard_publication();

-- +migrate Down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form') THEN
    DROP TRIGGER IF EXISTS form_publication_guarded ON assessment.form;
    DROP TRIGGER IF EXISTS form_born_a_draft ON assessment.form;
  END IF;
END $$;
DROP FUNCTION IF EXISTS assessment.guard_publication();
DROP FUNCTION IF EXISTS assessment.require_draft_on_insert();
DROP FUNCTION IF EXISTS assessment.anchor_floor_met(integer, integer);
