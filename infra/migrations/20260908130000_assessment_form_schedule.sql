-- The form's schedule window, and the states that follow publication (DOMAIN-MODEL §6, M6-20).
--
--   draft ──▶ published ──▶ embargoed ──▶ active ──▶ closed
--
-- A form past `draft` is frozen: its composition never changes, whichever of
-- those states it is in. What changes is its *state* and, once, its *window*:
-- scheduling sets `opens_at` and `closes_at`, and from then on they are fixed.
--
-- **The window is server-side fact, and an attempt's window is the form's.**
-- `attempt.window_closes_at` was a column the application supplied; it is now
-- tied to the form's `closes_at` by a composite foreign key, so an attempt
-- cannot carry a window the form does not have, whatever a client sent.
-- Attempts are created only on an `active` form.
--
-- The transition table is written out here as well as in the domain
-- (`form-state.ts`), and an integration spec holds the two to one answer over
-- every pair of states.
--
-- Nothing in this migration opens or closes a window by itself. That is a sweep
-- applying the clock to stored state, and no scheduler exists (D36).

-- +migrate Up

ALTER TABLE assessment.form DROP CONSTRAINT form_state_check;
ALTER TABLE assessment.form
  ADD CONSTRAINT form_state_check CHECK (state IN ('draft', 'published', 'embargoed', 'active', 'closed'));

ALTER TABLE assessment.form DROP CONSTRAINT form_published_at_matches_state;
ALTER TABLE assessment.form
  ADD CONSTRAINT form_published_at_matches_state CHECK ((state = 'draft') = (published_at IS NULL));

ALTER TABLE assessment.form ADD COLUMN opens_at timestamptz;
ALTER TABLE assessment.form ADD COLUMN closes_at timestamptz;

-- A window exists exactly when the form has been scheduled, and ends after it starts.
ALTER TABLE assessment.form
  ADD CONSTRAINT form_window_matches_state CHECK (
    (state IN ('embargoed', 'active', 'closed')) = (opens_at IS NOT NULL AND closes_at IS NOT NULL)
    AND (opens_at IS NULL) = (closes_at IS NULL)
    AND (opens_at IS NULL OR opens_at < closes_at)
  );

-- The target of attempt's composite key: the form and the moment its window closes.
ALTER TABLE assessment.form ADD CONSTRAINT form_window_key UNIQUE (form_id, closes_at);

ALTER TABLE assessment.attempt
  ADD CONSTRAINT attempt_window_is_the_forms FOREIGN KEY (form_id, window_closes_at)
    REFERENCES assessment.form (form_id, closes_at);

-- Attempts are created on an open form, not merely a published one.
CREATE OR REPLACE FUNCTION assessment.require_published_form() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  form_state text;
BEGIN
  SELECT state INTO form_state FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'assessment_attempt_requires_active_form: form % is %', NEW.form_id, COALESCE(form_state, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- A published form is frozen in everything but its state and, once, its window.
CREATE OR REPLACE FUNCTION assessment.reject_published_form_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN
    -- Still a draft. Editing, and publishing, are the point — and nothing else: a draft cannot skip ahead.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.state NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'assessment_form_transition_prohibited: form % cannot move % -> %', OLD.form_id, OLD.state, NEW.state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessment_published_form_is_immutable: form % was published at %; it is never deleted (D-006)', OLD.form_id, OLD.published_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(NEW.form_id, NEW.tenant_id, NEW.exam_profile_version_id, NEW.form_type, NEW.session_ref,
         NEW.blueprint_conformance, NEW.blueprint_conformance_schema_version, NEW.published_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.form_id, OLD.tenant_id, OLD.exam_profile_version_id, OLD.form_type, OLD.session_ref,
         OLD.blueprint_conformance, OLD.blueprint_conformance_schema_version, OLD.published_at, OLD.created_at) THEN
    RAISE EXCEPTION 'assessment_published_form_is_immutable: form % was published at %; only its state and window move (D-006)', OLD.form_id, OLD.published_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD.state, NEW.state) NOT IN (('published', 'embargoed'), ('embargoed', 'active'), ('active', 'closed')) THEN
    RAISE EXCEPTION 'assessment_form_transition_prohibited: form % cannot move % -> %', OLD.form_id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The window is set by scheduling and never changes after.
  IF OLD.state <> 'published' AND ROW(NEW.opens_at, NEW.closes_at) IS DISTINCT FROM ROW(OLD.opens_at, OLD.closes_at) THEN
    RAISE EXCEPTION 'assessment_form_window_is_fixed: form % was scheduled and its window does not move', OLD.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

-- +migrate Down

-- Restores what this migration replaced, guarded so it is a safe no-op against a schema-less database. The
-- two checks are re-added NOT VALID: rows in the later states exist by now and would otherwise stop the revert.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'attempt') THEN
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_window_is_the_forms;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form') THEN
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_window_key;
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_window_matches_state;
    ALTER TABLE assessment.form DROP COLUMN IF EXISTS opens_at;
    ALTER TABLE assessment.form DROP COLUMN IF EXISTS closes_at;
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_state_check;
    ALTER TABLE assessment.form ADD CONSTRAINT form_state_check CHECK (state IN ('draft', 'published')) NOT VALID;
    ALTER TABLE assessment.form DROP CONSTRAINT IF EXISTS form_published_at_matches_state;
    ALTER TABLE assessment.form ADD CONSTRAINT form_published_at_matches_state CHECK ((state = 'published') = (published_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'assessment') THEN
    EXECUTE $stmt$
CREATE OR REPLACE FUNCTION assessment.require_published_form() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  form_published timestamptz;
BEGIN
  SELECT published_at INTO form_published FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_published IS NULL THEN
    RAISE EXCEPTION 'assessment_attempt_requires_published_form: form % is not published', NEW.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

    $stmt$;
    EXECUTE $stmt$
CREATE OR REPLACE FUNCTION assessment.reject_published_form_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.published_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'assessment_published_form_is_immutable: form % was published at %; substitution is a draft-state operation only (D-006)',
    OLD.form_id, OLD.published_at
    USING ERRCODE = 'restrict_violation';
END $fn$;
    $stmt$;
  END IF;
END $$;
