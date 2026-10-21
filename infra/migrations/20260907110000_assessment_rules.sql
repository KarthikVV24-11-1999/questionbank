-- Append-only and immutability rules for the assessment schema, and its grants
-- (§9 rule 11; ASSESSMENT-ENGINE §4, §5; D-006; ADR-0030).
--
-- Three different rules, because the tables are three different kinds of thing:
--
--   response_event, attempt_slot — append-only from the moment a row exists.
--     A response is the factual record of what a learner did; no code path
--     updates or deletes one (REL-01). A row trigger refuses UPDATE and DELETE
--     from every role, the owner included, and the application role is granted
--     SELECT and INSERT only. TRUNCATE is the one path a row trigger cannot
--     see, so there the grant is the control — and it is never named.
--
--   form, form_section, form_slot — editable while a draft, immutable from
--     publication (D-006). The trigger keys on `published_at` as content's
--     does. Here the trigger is the control and the grant is the backstop,
--     because drafts legitimately need UPDATE and DELETE.
--
--   attempt — mutable only along the state machine. Its identity and pin never
--     change; its state moves only along the four edges ASSESSMENT-ENGINE §5
--     permits as amended by ADR-0030; a started attempt's deadline never moves;
--     and it is never deleted. This is a second implementation of the
--     transition rule the domain holds, and an integration spec asserts the two
--     agree over every state pair.
--
-- Two writes depend on another row's state, so they are checked here and not
-- left to a repository to remember:
--   * an attempt may only be created against a published form;
--   * a response is accepted only while the attempt is in progress (counts) or
--     submitted (recorded, excluded from scoring) — and `after_submission` is
--     set by this trigger from the attempt's state, whatever the caller said,
--     under a share lock on the attempt so a submission cannot slip between the
--     read and the insert.

-- +migrate Up

-- ── forms: immutable from publication ──────────────────────────────────────

CREATE OR REPLACE FUNCTION assessment.reject_published_form_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN
    -- Still a draft. Editing, and publishing, are the point.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'assessment_published_form_is_immutable: form % was published at %; substitution is a draft-state operation only (D-006)',
    OLD.form_id, OLD.published_at
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER form_immutable_once_published
  BEFORE UPDATE OR DELETE ON assessment.form
  FOR EACH ROW EXECUTE FUNCTION assessment.reject_published_form_mutation();

-- A form's sections and slots are the form: they freeze with it, or a
-- published form's composition could be edited without touching the row that
-- claims to be immutable.
CREATE OR REPLACE FUNCTION assessment.reject_published_form_child_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  owner_published timestamptz;
BEGIN
  owner_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.form_id ELSE OLD.form_id END;
  SELECT published_at INTO owner_published FROM assessment.form WHERE form_id = owner_id;

  IF owner_published IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'assessment_published_form_is_immutable: % belongs to form % published at %; substitution is a draft-state operation only (D-006)',
    TG_TABLE_NAME, owner_id, owner_published
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER form_section_frozen_with_its_form
  BEFORE INSERT OR UPDATE OR DELETE ON assessment.form_section
  FOR EACH ROW EXECUTE FUNCTION assessment.reject_published_form_child_mutation();

CREATE TRIGGER form_slot_frozen_with_its_form
  BEFORE INSERT OR UPDATE OR DELETE ON assessment.form_slot
  FOR EACH ROW EXECUTE FUNCTION assessment.reject_published_form_child_mutation();

-- ── attempt ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION assessment.require_published_form() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  form_published timestamptz;
BEGIN
  SELECT published_at INTO form_published FROM assessment.form WHERE form_id = NEW.form_id;
  IF form_published IS NULL THEN
    RAISE EXCEPTION 'assessment_attempt_requires_published_form: form % is not published', NEW.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER attempt_requires_published_form
  BEFORE INSERT ON assessment.attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.require_published_form();

CREATE OR REPLACE FUNCTION assessment.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity and pin: what the attempt is never changes (INV-04).
  IF ROW(NEW.attempt_id, NEW.tenant_id, NEW.student_id, NEW.mode, NEW.form_id, NEW.exam_profile_version_id,
         NEW.marking_rule_set_hash, NEW.taxonomy_version_id, NEW.delivery_policy, NEW.delivery_policy_schema_version,
         NEW.session_id, NEW.shift_id, NEW.duration_ms, NEW.window_closes_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.tenant_id, OLD.student_id, OLD.mode, OLD.form_id, OLD.exam_profile_version_id,
         OLD.marking_rule_set_hash, OLD.taxonomy_version_id, OLD.delivery_policy, OLD.delivery_policy_schema_version,
         OLD.session_id, OLD.shift_id, OLD.duration_ms, OLD.window_closes_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'assessment_attempt_pin_is_immutable: attempt % changed something other than its state', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The four edges of ASSESSMENT-ENGINE §5 as amended by ADR-0030. A move
  -- that is not one of them — including staying where it is — is refused.
  IF (OLD.state, NEW.state) NOT IN (
       ('created', 'in_progress'), ('created', 'abandoned'),
       ('in_progress', 'submitted'), ('in_progress', 'abandoned')) THEN
    RAISE EXCEPTION 'assessment_attempt_transition_prohibited: attempt % cannot move % -> %', OLD.attempt_id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The deadline is anchored at start and never recomputed.
  IF OLD.started_at IS NOT NULL
     AND ROW(NEW.started_at, NEW.deadline_at) IS DISTINCT FROM ROW(OLD.started_at, OLD.deadline_at) THEN
    RAISE EXCEPTION 'assessment_attempt_deadline_is_anchored: attempt % was started and its deadline is fixed', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER attempt_guarded_update
  BEFORE UPDATE ON assessment.attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_attempt_update();

CREATE TRIGGER attempt_never_deleted
  BEFORE DELETE ON assessment.attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- ── attempt_slot: pinned at creation, then never touched ───────────────────

CREATE OR REPLACE FUNCTION assessment.require_attempt_not_started() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
BEGIN
  SELECT state INTO attempt_state FROM assessment.attempt WHERE attempt_id = NEW.attempt_id;
  IF attempt_state IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'assessment_slots_are_pinned_at_creation: attempt % is % and its slots are already pinned', NEW.attempt_id, attempt_state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER attempt_slot_pinned_at_creation
  BEFORE INSERT ON assessment.attempt_slot
  FOR EACH ROW EXECUTE FUNCTION assessment.require_attempt_not_started();

CREATE TRIGGER attempt_slot_append_only
  BEFORE UPDATE OR DELETE ON assessment.attempt_slot
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- ── response_event: the append-only log ────────────────────────────────────

CREATE OR REPLACE FUNCTION assessment.classify_response_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
BEGIN
  -- FOR SHARE: a submission is an UPDATE of this row, so it waits for this
  -- insert to commit, and an event is classified against the state it will
  -- actually be stored under.
  SELECT state INTO attempt_state FROM assessment.attempt WHERE attempt_id = NEW.attempt_id FOR SHARE;
  IF attempt_state = 'in_progress' THEN
    NEW.after_submission := false;
  ELSIF attempt_state = 'submitted' THEN
    NEW.after_submission := true;
  ELSE
    RAISE EXCEPTION 'assessment_attempt_not_accepting_responses: attempt % is %', NEW.attempt_id, COALESCE(attempt_state, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER response_event_classified
  BEFORE INSERT ON assessment.response_event
  FOR EACH ROW EXECUTE FUNCTION assessment.classify_response_event();

CREATE TRIGGER response_event_append_only
  BEFORE UPDATE OR DELETE ON assessment.response_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- ── grants ─────────────────────────────────────────────────────────────────
-- Conditional because the role is created by the deployment (M0-24 locally); a
-- database without it yet is not a broken migration. Default privileges make a
-- future `assessment` table append-only for the application role until someone
-- decides otherwise.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT USAGE ON SCHEMA assessment TO questionbank_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA assessment TO questionbank_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA assessment GRANT SELECT, INSERT ON TABLES TO questionbank_app;

    -- Drafts are edited and deleted; the trigger freezes a published form.
    GRANT UPDATE, DELETE ON assessment.form, assessment.form_section, assessment.form_slot TO questionbank_app;
    -- An attempt moves through its states and is never deleted.
    GRANT UPDATE ON assessment.attempt TO questionbank_app;

    -- Named explicitly as well, so the refusal does not rest on what a
    -- default happened to be when the table was created.
    REVOKE UPDATE, DELETE, TRUNCATE ON assessment.response_event FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON assessment.attempt_slot FROM questionbank_app;
    REVOKE DELETE, TRUNCATE ON assessment.attempt FROM questionbank_app;
    REVOKE TRUNCATE ON assessment.form, assessment.form_section, assessment.form_slot FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Safe no-op against a schema-less database: every statement is guarded on the
-- thing it touches existing, since `revertMigrations()` runs every down script
-- against whatever state the database happens to be in.
DO $$
DECLARE
  triggers text[][] := ARRAY[
    ['form', 'form_immutable_once_published'],
    ['form_section', 'form_section_frozen_with_its_form'],
    ['form_slot', 'form_slot_frozen_with_its_form'],
    ['attempt', 'attempt_requires_published_form'],
    ['attempt', 'attempt_guarded_update'],
    ['attempt', 'attempt_never_deleted'],
    ['attempt_slot', 'attempt_slot_pinned_at_creation'],
    ['attempt_slot', 'attempt_slot_append_only'],
    ['response_event', 'response_event_classified'],
    ['response_event', 'response_event_append_only']
  ];
  pair text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'assessment') THEN
    FOREACH pair SLICE 1 IN ARRAY triggers
    LOOP
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = pair[1]) THEN
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON assessment.%I', pair[2], pair[1]);
      END IF;
    END LOOP;

    DROP FUNCTION IF EXISTS assessment.reject_published_form_mutation();
    DROP FUNCTION IF EXISTS assessment.reject_published_form_child_mutation();
    DROP FUNCTION IF EXISTS assessment.require_published_form();
    DROP FUNCTION IF EXISTS assessment.guard_attempt_update();
    DROP FUNCTION IF EXISTS assessment.require_attempt_not_started();
    DROP FUNCTION IF EXISTS assessment.classify_response_event();

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
      ALTER DEFAULT PRIVILEGES IN SCHEMA assessment REVOKE SELECT, INSERT ON TABLES FROM questionbank_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA assessment FROM questionbank_app;
      REVOKE USAGE ON SCHEMA assessment FROM questionbank_app;
    END IF;
  END IF;
END
$$;
