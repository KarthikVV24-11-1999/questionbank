-- The exposure ledger counts a practice delivery, under a constraint that is still total (ASSESSMENT-ENGINE §6, §12, M7-30).
--
-- The ledger is the one record that stops an item being burned. Every row was tied to a *form* and a *session* by composite keys, and a practice
-- run has neither, so the easy move — exempt practice from `exposure_ledger_matches_session` — would leave the record silently incomplete for the
-- delivery path that carries the most volume. This migration does not exempt anything. A practice delivery has a **different key**: the attempt
-- slot that delivered it.
--
-- A ledger row now names exactly one of two things it describes:
--
--   * a form slot  — (form_id, slot_id, item_id, item_version_id, is_anchor), with its session; written at publication, as before;
--   * an attempt slot — (attempt_id, slot_id, item_id, item_version_id); written in the transaction that pins the slot.
--
-- "Exactly one" is a CHECK on every row, not a rule about a mode: `(form_id IS NULL) = (attempt_id IS NOT NULL)`, and the form's session and anchor
-- flag are present exactly when the form is. The old composite keys are untouched and fire whenever their columns are present; the new composite
-- key onto `attempt_slot` fires whenever `attempt_id` is. Every row is therefore checked by one of the two, and a row cannot say something the slot
-- it describes does not.
--
-- The other direction — that a practice slot cannot be delivered *without* its row — is a deferred constraint trigger on `attempt_slot`: at commit,
-- every slot of an attempt with no form has its ledger row, or the transaction fails. So practice cannot be the hole.
--
-- Not counted here: per-session normalization (ADR-0032) joins exposure to the attempts of a form's session, and a practice run has no session.
-- `exposureBySession` reads form rows only. Item counts (`countsByItemVersion`) read both: a practice delivery is a placement of that version.

-- +migrate Up

-- The target of the ledger's composite key to an attempt slot: the slot as it stood.
ALTER TABLE assessment.attempt_slot
  ADD CONSTRAINT attempt_slot_exposure_key UNIQUE (attempt_id, slot_id, item_id, item_version_id);

ALTER TABLE assessment.exposure_ledger_entry
  ADD COLUMN attempt_id uuid,
  ALTER COLUMN form_id DROP NOT NULL,
  ALTER COLUMN session_ref DROP NOT NULL,
  ALTER COLUMN is_anchor DROP NOT NULL;

ALTER TABLE assessment.exposure_ledger_entry
  ADD CONSTRAINT exposure_ledger_describes_one_slot CHECK ((form_id IS NULL) = (attempt_id IS NOT NULL)),
  ADD CONSTRAINT exposure_ledger_form_columns_travel_together CHECK ((form_id IS NULL) = (session_ref IS NULL) AND (form_id IS NULL) = (is_anchor IS NULL)),
  ADD CONSTRAINT exposure_ledger_one_row_per_attempt_slot UNIQUE (attempt_id, slot_id),
  ADD CONSTRAINT exposure_ledger_matches_attempt_slot FOREIGN KEY (attempt_id, slot_id, item_id, item_version_id)
    REFERENCES assessment.attempt_slot (attempt_id, slot_id, item_id, item_version_id);

CREATE OR REPLACE FUNCTION assessment.require_draft_form_for_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  form_state text;
  slot_attempt_form uuid;
  slot_attempt_state text;
BEGIN
  IF NEW.form_id IS NULL THEN
    -- A practice delivery: its attempt must be one with no form that is still being sat.
    SELECT form_id, state INTO slot_attempt_form, slot_attempt_state FROM assessment.attempt WHERE attempt_id = NEW.attempt_id;
    IF slot_attempt_state IS NULL OR slot_attempt_form IS NOT NULL OR slot_attempt_state NOT IN ('created', 'in_progress') THEN
      RAISE EXCEPTION 'assessment_ledger_practice_row_needs_a_live_practice_attempt: attempt % is not a practice attempt being sat', NEW.attempt_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT state INTO form_state FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'assessment_ledger_is_written_at_publication: form % is % and its exposure is already fixed', NEW.form_id, COALESCE(form_state, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION assessment.require_ledger_row_for_practice_slot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM assessment.attempt WHERE attempt_id = NEW.attempt_id AND form_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM assessment.exposure_ledger_entry WHERE attempt_id = NEW.attempt_id AND slot_id = NEW.slot_id) THEN
    RAISE EXCEPTION 'assessment_practice_delivery_is_exposure: slot % of practice attempt % has no ledger row', NEW.slot_id, NEW.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER attempt_slot_practice_is_exposed
  AFTER INSERT ON assessment.attempt_slot
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assessment.require_ledger_row_for_practice_slot();

-- +migrate Down

DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'assessment' AND table_name = 'exposure_ledger_entry' AND column_name = 'attempt_id') THEN
    IF EXISTS (SELECT 1 FROM assessment.exposure_ledger_entry WHERE form_id IS NULL) THEN
      RAISE EXCEPTION 'assessment_exposure_counts_practice_down: practice deliveries are in the ledger and the earlier shape cannot hold them';
    END IF;
    DROP TRIGGER IF EXISTS attempt_slot_practice_is_exposed ON assessment.attempt_slot;
    DROP FUNCTION IF EXISTS assessment.require_ledger_row_for_practice_slot();
    ALTER TABLE assessment.exposure_ledger_entry
      DROP CONSTRAINT IF EXISTS exposure_ledger_matches_attempt_slot,
      DROP CONSTRAINT IF EXISTS exposure_ledger_one_row_per_attempt_slot,
      DROP CONSTRAINT IF EXISTS exposure_ledger_form_columns_travel_together,
      DROP CONSTRAINT IF EXISTS exposure_ledger_describes_one_slot;
    ALTER TABLE assessment.exposure_ledger_entry
      DROP COLUMN attempt_id,
      ALTER COLUMN form_id SET NOT NULL,
      ALTER COLUMN session_ref SET NOT NULL,
      ALTER COLUMN is_anchor SET NOT NULL;
    ALTER TABLE assessment.attempt_slot DROP CONSTRAINT IF EXISTS attempt_slot_exposure_key;
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION assessment.require_draft_form_for_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      DECLARE
        form_state text;
      BEGIN
        SELECT state INTO form_state FROM assessment.form WHERE form_id = NEW.form_id;
        IF form_state IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'assessment_ledger_is_written_at_publication: form % is % and its exposure is already fixed', NEW.form_id, COALESCE(form_state, 'unknown')
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $body$
    $fn$;
  END IF;
END $down$;
