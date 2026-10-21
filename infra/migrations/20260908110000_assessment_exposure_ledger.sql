-- The exposure ledger (ASSESSMENT-ENGINE §6, §12, M6-18), and the session a form is published for.
--
-- §12 lists "per-item exposure with form and session identity" among the things
-- that must be captured from the first attempt because they cannot be
-- reconstructed. So a form carries `session_ref`, the sitting it is published
-- for, and the ledger copies it onto every row.
--
-- Written at publication and nowhere else (§6: the form's composition is what
-- determines exposure, and it must be known before students arrive). Three
-- controls make that structural rather than a convention:
--   * the application role holds SELECT and INSERT only, and a row trigger
--     refuses UPDATE and DELETE from everyone;
--   * a row may only be inserted while its form is still a draft — the
--     publication transaction writes the ledger and then moves the form to
--     published, so once the form is published no later write, an attempt-time
--     one included, can add a row;
--   * a composite foreign key ties each row to the slot it describes, so a row
--     cannot say something the slot does not (item version, anchor flag) and
--     cannot carry a session other than the form's.
--
-- It lives in `assessment` although the context map gives exposure to
-- Psychometrics (ADR-0031). No foreign key leaves the schema.

-- +migrate Up

-- The column is NOT NULL, and forms published before it existed (none outside a
-- test database) are given a recognisably synthetic session so the constraint
-- can hold. The immutability trigger is lifted for that one statement only.
ALTER TABLE assessment.form ADD COLUMN session_ref text;
ALTER TABLE assessment.form DISABLE TRIGGER form_immutable_once_published;
UPDATE assessment.form SET session_ref = 'unassigned:' || form_id::text WHERE session_ref IS NULL;
ALTER TABLE assessment.form ENABLE TRIGGER form_immutable_once_published;
ALTER TABLE assessment.form ALTER COLUMN session_ref SET NOT NULL;
ALTER TABLE assessment.form ADD CONSTRAINT form_session_ref_not_blank CHECK (length(btrim(session_ref)) > 0);
-- The target of the ledger's composite key: the form and the session it was published for.
ALTER TABLE assessment.form ADD CONSTRAINT form_session_key UNIQUE (form_id, session_ref);

-- The target of the ledger's composite key to a slot: the slot as it stood.
ALTER TABLE assessment.form_slot
  ADD CONSTRAINT form_slot_exposure_key UNIQUE (form_id, slot_id, item_id, item_version_id, is_anchor);

CREATE TABLE assessment.exposure_ledger_entry (
  entry_id         uuid PRIMARY KEY DEFAULT assessment.uuid_generate_v7(),
  tenant_id        uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  form_id          uuid NOT NULL,
  slot_id          uuid NOT NULL,
  item_id          uuid NOT NULL,
  -- §12: the version, not the item.
  item_version_id  uuid NOT NULL,
  -- §12: the session identity. Not nullable.
  session_ref      text NOT NULL CHECK (length(btrim(session_ref)) > 0),
  is_anchor        boolean NOT NULL,
  written_at       timestamptz NOT NULL,

  -- A form is counted once per slot, so publishing twice cannot double-count.
  CONSTRAINT exposure_ledger_one_row_per_slot UNIQUE (form_id, slot_id),
  CONSTRAINT exposure_ledger_matches_slot FOREIGN KEY (form_id, slot_id, item_id, item_version_id, is_anchor)
    REFERENCES assessment.form_slot (form_id, slot_id, item_id, item_version_id, is_anchor),
  CONSTRAINT exposure_ledger_matches_session FOREIGN KEY (form_id, session_ref)
    REFERENCES assessment.form (form_id, session_ref)
);

-- "How many forms has this version been placed in" — what exposure balance and an anchor's cap both ask.
CREATE INDEX exposure_ledger_item_version_idx ON assessment.exposure_ledger_entry (item_version_id);

CREATE OR REPLACE FUNCTION assessment.require_draft_form_for_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  form_state text;
BEGIN
  SELECT state INTO form_state FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'assessment_ledger_is_written_at_publication: form % is % and its exposure is already fixed', NEW.form_id, COALESCE(form_state, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER exposure_ledger_written_at_publication
  BEFORE INSERT ON assessment.exposure_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION assessment.require_draft_form_for_ledger();

CREATE TRIGGER exposure_ledger_append_only
  BEFORE UPDATE OR DELETE ON assessment.exposure_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT ON assessment.exposure_ledger_entry TO questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON assessment.exposure_ledger_entry FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS assessment.exposure_ledger_entry;
DROP FUNCTION IF EXISTS assessment.require_draft_form_for_ledger();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form_slot') THEN
    ALTER TABLE assessment.form_slot DROP CONSTRAINT IF EXISTS form_slot_exposure_key;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form') THEN
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_session_key;
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_session_ref_not_blank;
    ALTER TABLE assessment.form DROP COLUMN IF EXISTS session_ref;
  END IF;
END $$;
