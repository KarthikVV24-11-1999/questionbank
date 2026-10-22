-- +migrate Up

-- Creating an attempt is idempotent on a key the caller chose (M6-30): a retry of a create that
-- succeeded must return the same attempt and never a second. The key belongs to the student who
-- chose it, so two students' keys never collide, and it is part of the attempt's identity: fixed
-- at creation and refused a change like everything else the pin protects.
--
-- Nullable, with the uniqueness partial: attempts written before this had no key to retry on, and a
-- fixture that inserts a row directly has none either. An attempt the route creates always has one.
ALTER TABLE assessment.attempt
  ADD COLUMN creation_key text CHECK (creation_key IS NULL OR length(btrim(creation_key)) > 0);

CREATE UNIQUE INDEX attempt_creation_key_per_student
  ON assessment.attempt (student_id, creation_key)
  WHERE creation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION assessment.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity and pin: what the attempt is never changes (INV-04).
  IF ROW(NEW.attempt_id, NEW.tenant_id, NEW.student_id, NEW.mode, NEW.form_id, NEW.exam_profile_version_id,
         NEW.marking_rule_set_hash, NEW.taxonomy_version_id, NEW.delivery_policy, NEW.delivery_policy_schema_version,
         NEW.session_ref, NEW.shift_id, NEW.duration_ms, NEW.window_closes_at, NEW.created_at, NEW.creation_key)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.tenant_id, OLD.student_id, OLD.mode, OLD.form_id, OLD.exam_profile_version_id,
         OLD.marking_rule_set_hash, OLD.taxonomy_version_id, OLD.delivery_policy, OLD.delivery_policy_schema_version,
         OLD.session_ref, OLD.shift_id, OLD.duration_ms, OLD.window_closes_at, OLD.created_at, OLD.creation_key)
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

-- A structural revert: the key and its index go. The function body the session-identity migration wrote is
-- restored by reverting that migration, which the test harness does by dropping the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'attempt') THEN
    DROP INDEX IF EXISTS assessment.attempt_creation_key_per_student;
    ALTER TABLE assessment.attempt DROP COLUMN IF EXISTS creation_key;
  END IF;
END $$;
