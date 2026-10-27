-- The attempt admits practice (DOMAIN-MODEL D2, M7-25).
--
-- D2: Attempt is one aggregate, mode-parameterized — mock, practice and diagnostic. The schema built for mocks
-- forbade the third value, and five columns could only be supplied by a form. This migration makes them
-- storable **without making any rule conditional on the mode**.
--
-- How, and why it stays total. Every constraint below is evaluated for every row. Where a column is only
-- meaningful with a form, it is nullable and tied to `form_id` by a CHECK — all of them are null together, or
-- none is — and `form_id` is tied to `mode` by a CHECK. A form-bearing row is therefore checked by every
-- composite foreign key that already existed (`attempt_form_fkey`, `attempt_window_is_the_forms`,
-- `attempt_session_is_one_the_form_was_published_for`), because those keys fire whenever their columns are
-- present, and nothing in them was relaxed. A row with no form is checked by the CHECKs that say it may have none.
--
--   * a form is carried exactly when the attempt is not practice. A diagnostic keeps its form: DOMAIN-MODEL
--     gives Form a `formType` of mock or diagnostic, and `attempt_form_fkey` already ties an attempt's mode to
--     its form's type, so a diagnostic with no form would be a regression, not a clarification;
--   * the form's session, shift and window travel with the form: all present, or all absent;
--   * a duration, and a deadline once started, follow a pinned `is_timed` column and not the mode. `is_timed`
--     is derived from the delivery policy when the attempt is created (the one place it is derived) and, like
--     `mode` and `delivery_policy`, is never granted `UPDATE` and is refused by the guard trigger.
--
-- The application role's UPDATE on `attempt` was the whole table, held in check by a trigger. It is now the seven
-- lifecycle columns and nothing else, so `mode`, `delivery_policy` and `is_timed` are unwritable by grant as well
-- as by trigger. Fitness rule F40 reads the column grants against an allow-list.

-- +migrate Up

-- Defaulted to timed, which is what every attempt before this was. The default cannot hide a mistake: an attempt that
-- is untimed and forgets to say so carries no duration, and `attempt_duration_follows_timing` refuses it.
ALTER TABLE assessment.attempt ADD COLUMN is_timed boolean NOT NULL DEFAULT true;

ALTER TABLE assessment.attempt DROP CONSTRAINT attempt_mode_check;
ALTER TABLE assessment.attempt ADD CONSTRAINT attempt_mode_check CHECK (mode IN ('mock', 'practice', 'diagnostic'));

ALTER TABLE assessment.attempt
  ALTER COLUMN form_id DROP NOT NULL,
  ALTER COLUMN session_ref DROP NOT NULL,
  ALTER COLUMN shift_id DROP NOT NULL,
  ALTER COLUMN window_closes_at DROP NOT NULL,
  ALTER COLUMN duration_ms DROP NOT NULL;

ALTER TABLE assessment.attempt
  ADD CONSTRAINT attempt_form_exactly_when_not_practice CHECK ((mode = 'practice') = (form_id IS NULL)),
  ADD CONSTRAINT attempt_form_columns_travel_together CHECK (
    (form_id IS NULL) = (session_ref IS NULL)
    AND (form_id IS NULL) = (shift_id IS NULL)
    AND (form_id IS NULL) = (window_closes_at IS NULL)
  ),
  ADD CONSTRAINT attempt_duration_follows_timing CHECK (is_timed = (duration_ms IS NOT NULL));

-- The state shape, with the deadline following timing rather than being tied to the start alone.
ALTER TABLE assessment.attempt DROP CONSTRAINT attempt_state_shape;
ALTER TABLE assessment.attempt ADD CONSTRAINT attempt_state_shape CHECK (
  (deadline_at IS NOT NULL) = (is_timed AND started_at IS NOT NULL)
  AND CASE state
    WHEN 'created' THEN
      started_at IS NULL AND submitted_at IS NULL AND submission_reason IS NULL
      AND idempotency_key IS NULL AND abandoned_at IS NULL
    WHEN 'in_progress' THEN
      started_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL
      AND idempotency_key IS NULL AND abandoned_at IS NULL
    WHEN 'submitted' THEN
      started_at IS NOT NULL AND submitted_at IS NOT NULL AND submission_reason IS NOT NULL
      AND idempotency_key IS NOT NULL AND abandoned_at IS NULL
    ELSE
      abandoned_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL
      AND idempotency_key IS NULL
  END
);

CREATE OR REPLACE FUNCTION assessment.require_published_form() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  form_state text;
BEGIN
  -- No form: the CHECKs above have already said this row is practice or are about to refuse it.
  IF NEW.form_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT state INTO form_state FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'assessment_attempt_requires_active_form: form % is %', NEW.form_id, COALESCE(form_state, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION assessment.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity and pin: what the attempt is never changes (INV-04).
  IF ROW(NEW.attempt_id, NEW.tenant_id, NEW.student_id, NEW.mode, NEW.form_id, NEW.exam_profile_version_id,
         NEW.marking_rule_set_hash, NEW.taxonomy_version_id, NEW.delivery_policy, NEW.delivery_policy_schema_version,
         NEW.session_ref, NEW.shift_id, NEW.duration_ms, NEW.is_timed, NEW.interval_cap_ms, NEW.window_closes_at,
         NEW.created_at, NEW.creation_key)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.tenant_id, OLD.student_id, OLD.mode, OLD.form_id, OLD.exam_profile_version_id,
         OLD.marking_rule_set_hash, OLD.taxonomy_version_id, OLD.delivery_policy, OLD.delivery_policy_schema_version,
         OLD.session_ref, OLD.shift_id, OLD.duration_ms, OLD.is_timed, OLD.interval_cap_ms, OLD.window_closes_at,
         OLD.created_at, OLD.creation_key)
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE UPDATE ON assessment.attempt FROM questionbank_app;
    GRANT UPDATE (state, started_at, deadline_at, submitted_at, submission_reason, idempotency_key, abandoned_at)
      ON assessment.attempt TO questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- A structural revert. Rows a practice attempt wrote cannot satisfy the earlier shape, so a database that holds one
-- is refused rather than altered silently; the test harness reverts by dropping the schema.
DO $$
BEGIN
  -- Guarded on the column itself: a revert runs every down script against whatever state the database is in.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'assessment' AND table_name = 'attempt' AND column_name = 'is_timed') THEN
    IF EXISTS (SELECT 1 FROM assessment.attempt WHERE form_id IS NULL OR NOT is_timed) THEN
      RAISE EXCEPTION 'assessment_attempt_admits_practice_down: practice or untimed attempts exist and the earlier shape cannot hold them';
    END IF;
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_form_exactly_when_not_practice;
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_form_columns_travel_together;
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_duration_follows_timing;
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_state_shape;
    ALTER TABLE assessment.attempt ADD CONSTRAINT attempt_state_shape CHECK (
      (started_at IS NULL) = (deadline_at IS NULL)
      AND CASE state
        WHEN 'created' THEN started_at IS NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL AND abandoned_at IS NULL
        WHEN 'in_progress' THEN started_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL AND abandoned_at IS NULL
        WHEN 'submitted' THEN started_at IS NOT NULL AND submitted_at IS NOT NULL AND submission_reason IS NOT NULL AND idempotency_key IS NOT NULL AND abandoned_at IS NULL
        ELSE abandoned_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL
      END
    );
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_mode_check;
    ALTER TABLE assessment.attempt ADD CONSTRAINT attempt_mode_check CHECK (mode IN ('mock', 'diagnostic'));
    ALTER TABLE assessment.attempt
      ALTER COLUMN form_id SET NOT NULL,
      ALTER COLUMN session_ref SET NOT NULL,
      ALTER COLUMN shift_id SET NOT NULL,
      ALTER COLUMN window_closes_at SET NOT NULL,
      ALTER COLUMN duration_ms SET NOT NULL;
    ALTER TABLE assessment.attempt DROP COLUMN IF EXISTS is_timed;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
      REVOKE UPDATE (state, started_at, deadline_at, submitted_at, submission_reason, idempotency_key, abandoned_at) ON assessment.attempt FROM questionbank_app;
      GRANT UPDATE ON assessment.attempt TO questionbank_app;
    END IF;
  END IF;
END $$;
