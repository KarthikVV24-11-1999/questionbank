-- +migrate Up

-- The cap on one visit-to-leave interval towards time on item is pinned onto the attempt when it is created (M6-37), from
-- the one configured value, and told to the device in the attempt response. It is part of what the attempt *is*, like its
-- duration: a later change to the configuration cannot make a device and the server project one log with two caps.
--
-- Added nullable, backfilled, then made required. The backfill is a one-time value for rows that predate pinning (there are
-- none outside a development database); it is the configured default at the time of writing and is not read again.
ALTER TABLE assessment.attempt ADD COLUMN interval_cap_ms integer;
UPDATE assessment.attempt SET interval_cap_ms = 120000 WHERE interval_cap_ms IS NULL;
ALTER TABLE assessment.attempt
  ALTER COLUMN interval_cap_ms SET NOT NULL,
  ADD CONSTRAINT attempt_interval_cap_positive CHECK (interval_cap_ms > 0);

CREATE OR REPLACE FUNCTION assessment.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity and pin: what the attempt is never changes (INV-04).
  IF ROW(NEW.attempt_id, NEW.tenant_id, NEW.student_id, NEW.mode, NEW.form_id, NEW.exam_profile_version_id,
         NEW.marking_rule_set_hash, NEW.taxonomy_version_id, NEW.delivery_policy, NEW.delivery_policy_schema_version,
         NEW.session_ref, NEW.shift_id, NEW.duration_ms, NEW.interval_cap_ms, NEW.window_closes_at, NEW.created_at, NEW.creation_key)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.tenant_id, OLD.student_id, OLD.mode, OLD.form_id, OLD.exam_profile_version_id,
         OLD.marking_rule_set_hash, OLD.taxonomy_version_id, OLD.delivery_policy, OLD.delivery_policy_schema_version,
         OLD.session_ref, OLD.shift_id, OLD.duration_ms, OLD.interval_cap_ms, OLD.window_closes_at, OLD.created_at, OLD.creation_key)
  THEN
    RAISE EXCEPTION 'assessment_attempt_pin_is_immutable: attempt % changed something other than its state', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD.state, NEW.state) NOT IN (
       ('created', 'in_progress'), ('created', 'abandoned'),
       ('in_progress', 'submitted'), ('in_progress', 'abandoned')) THEN
    RAISE EXCEPTION 'assessment_attempt_transition_prohibited: attempt % cannot move % -> %', OLD.attempt_id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.started_at IS NOT NULL
     AND ROW(NEW.started_at, NEW.deadline_at) IS DISTINCT FROM ROW(OLD.started_at, OLD.deadline_at) THEN
    RAISE EXCEPTION 'assessment_attempt_deadline_is_anchored: attempt % was started and its deadline is fixed', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

-- +migrate Down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'attempt') THEN
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_interval_cap_positive;
    ALTER TABLE assessment.attempt DROP COLUMN IF EXISTS interval_cap_ms;
  END IF;
END $$;
