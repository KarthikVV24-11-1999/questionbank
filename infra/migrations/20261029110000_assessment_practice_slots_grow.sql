-- A practice attempt's slot list grows, and a pin only ever gains rows (DOMAIN-MODEL D2, INV-04, M7-27).
--
-- D2 says mocks pin a Form while practice grows its slot list as it goes; INV-04 says an attempt is pinned at creation. Both hold, because the
-- pin was never the attempt's list — it is `attempt_slot`, one row per slot recording the one item version that slot was given, and
-- `response_event` is tied to it by the composite key `response_event_pin_matches_slot (attempt_id, slot_id, item_version_id)`. Growing a list
-- INSERTs a pin. Nothing here lets a pin change: `attempt_slot_append_only` still refuses every UPDATE and DELETE, from every role, and a
-- response recorded before the list grew resolves to the version it was given after.
--
-- What changes is the one trigger that said "a slot is written while the attempt is `created`". It now also admits a slot while the attempt is
-- `in_progress`, **keyed on a pinned column**: the attempt has no form. `form_id` is never updated (the guard trigger and the column grant),
-- so the rule that a slot may be added later depends on a fact that cannot change. A mock or diagnostic attempt — which has a form — keeps
-- exactly the rule it had: its slots are the form's, fixed at creation.

-- +migrate Up

CREATE OR REPLACE FUNCTION assessment.require_attempt_not_started() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
  attempt_form uuid;
BEGIN
  SELECT state, form_id INTO attempt_state, attempt_form FROM assessment.attempt WHERE attempt_id = NEW.attempt_id;
  -- A practice attempt has no form and takes slots while it is being sat. Nothing about an existing slot is reachable from here.
  IF attempt_form IS NULL AND attempt_state IN ('created', 'in_progress') THEN
    RETURN NEW;
  END IF;
  IF attempt_state IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'assessment_slots_are_pinned_at_creation: attempt % is % and its slots are already pinned', NEW.attempt_id, attempt_state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- +migrate Down

-- Guarded: a revert runs every down script against whatever state the database is in, and the schema may already be gone.
DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'assessment' AND p.proname = 'require_attempt_not_started') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION assessment.require_attempt_not_started() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      DECLARE
        attempt_state text;
      BEGIN
        SELECT state INTO attempt_state FROM assessment.attempt WHERE attempt_id = NEW.attempt_id;
        IF attempt_state IS DISTINCT FROM 'created' THEN
          RAISE EXCEPTION 'assessment_slots_are_pinned_at_creation: attempt % is % and its slots are already pinned', NEW.attempt_id, attempt_state
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $body$
    $fn$;
  END IF;
END $down$;
