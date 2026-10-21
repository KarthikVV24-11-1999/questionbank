-- One session identity (ASSESSMENT-ENGINE §12, §10; ADR-0032, M6-21).
--
-- §12 asks for per-item exposure with form AND session identity, and for the
-- attempt's own session identity, so that multi-shift normalization can group
-- attempts by session and read that same session's exposure. Until now the
-- form's session was free text, the ledger copied it, and the attempt carried
-- an unrelated uuid supplied by its caller: three identifiers nothing could
-- say were the same sitting.
--
-- **A session is a named sitting, and its identity is a canonical text key
-- that a form declares.** `form_session` lists the sittings a form is published
-- for. Everything else is made to *be* that key rather than to agree with it,
-- by composite foreign keys — the technique already used for the attempt's mode
-- (`attempt_form_fkey`) and window (`attempt_window_is_the_forms`):
--
--   * the ledger holds a row per slot per session, keyed to `form_session`;
--   * an attempt's `session_ref` is keyed to the same row, so it cannot name a
--     session its form was not published for.
--
-- `shift_id` stays what it was: a caller-supplied label within a session. It is
-- carried, not joined.
--
-- The attempt's old `session_id` (a uuid for the login session) goes. The
-- authentication session never ended an attempt and is not what §12 means.
--
-- **The `unassigned:` placeholders.** M6-18 backfilled forms that existed before
-- `session_ref` with `unassigned:<form_id>`. Those are not sessions. A draft
-- carrying one is left without a session and must declare real ones before it
-- can be published; a form already past draft cannot be edited, so this
-- migration refuses to run if there is one, rather than invent a session for a
-- sitting that may already have been sat. (There are none outside a test
-- database: the repository has no production data.)

-- +migrate Up

DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM assessment.form WHERE session_ref LIKE 'unassigned:%' AND state <> 'draft';
  IF stranded > 0 THEN
    RAISE EXCEPTION 'assessment_session_identity_needs_real_sessions: % published form(s) carry an unassigned placeholder; assign real sessions before migrating', stranded;
  END IF;
END $$;

CREATE TABLE assessment.form_session (
  form_id      uuid NOT NULL REFERENCES assessment.form (form_id),
  -- Canonical: trimmed, non-empty, and never a placeholder.
  session_ref  text NOT NULL
                 CHECK (session_ref = btrim(session_ref) AND length(session_ref) > 0 AND session_ref NOT LIKE 'unassigned:%'),

  PRIMARY KEY (form_id, session_ref)
);

INSERT INTO assessment.form_session (form_id, session_ref)
  SELECT form_id, btrim(session_ref) FROM assessment.form
   WHERE session_ref NOT LIKE 'unassigned:%' AND length(btrim(session_ref)) > 0;

-- The sittings are part of the form: they freeze with it.
CREATE TRIGGER form_session_frozen_with_its_form
  BEFORE INSERT OR UPDATE OR DELETE ON assessment.form_session
  FOR EACH ROW EXECUTE FUNCTION assessment.reject_published_form_child_mutation();

-- ── the ledger: a row per slot per session ──────────────────────────────────

ALTER TABLE assessment.exposure_ledger_entry DROP CONSTRAINT exposure_ledger_matches_session;
ALTER TABLE assessment.exposure_ledger_entry DROP CONSTRAINT exposure_ledger_one_row_per_slot;
ALTER TABLE assessment.exposure_ledger_entry
  ADD CONSTRAINT exposure_ledger_one_row_per_slot_per_session UNIQUE (form_id, slot_id, session_ref);
ALTER TABLE assessment.exposure_ledger_entry
  ADD CONSTRAINT exposure_ledger_matches_session FOREIGN KEY (form_id, session_ref)
    REFERENCES assessment.form_session (form_id, session_ref);

-- ── the attempt: its session IS one of its form's ───────────────────────────

ALTER TABLE assessment.attempt ADD COLUMN session_ref text;
ALTER TABLE assessment.attempt DISABLE TRIGGER attempt_guarded_update;
UPDATE assessment.attempt a SET session_ref = btrim(f.session_ref) FROM assessment.form f WHERE f.form_id = a.form_id;
ALTER TABLE assessment.attempt ENABLE TRIGGER attempt_guarded_update;
ALTER TABLE assessment.attempt ALTER COLUMN session_ref SET NOT NULL;
ALTER TABLE assessment.attempt DROP COLUMN session_id;
ALTER TABLE assessment.attempt
  ADD CONSTRAINT attempt_session_is_one_the_form_was_published_for FOREIGN KEY (form_id, session_ref)
    REFERENCES assessment.form_session (form_id, session_ref);

CREATE OR REPLACE FUNCTION assessment.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity and pin: what the attempt is never changes (INV-04).
  IF ROW(NEW.attempt_id, NEW.tenant_id, NEW.student_id, NEW.mode, NEW.form_id, NEW.exam_profile_version_id,
         NEW.marking_rule_set_hash, NEW.taxonomy_version_id, NEW.delivery_policy, NEW.delivery_policy_schema_version,
         NEW.session_ref, NEW.shift_id, NEW.duration_ms, NEW.window_closes_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.attempt_id, OLD.tenant_id, OLD.student_id, OLD.mode, OLD.form_id, OLD.exam_profile_version_id,
         OLD.marking_rule_set_hash, OLD.taxonomy_version_id, OLD.delivery_policy, OLD.delivery_policy_schema_version,
         OLD.session_ref, OLD.shift_id, OLD.duration_ms, OLD.window_closes_at, OLD.created_at)
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

-- ── the form no longer carries a single session ─────────────────────────────

CREATE OR REPLACE FUNCTION assessment.reject_published_form_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN
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

  IF ROW(NEW.form_id, NEW.tenant_id, NEW.exam_profile_version_id, NEW.form_type,
         NEW.blueprint_conformance, NEW.blueprint_conformance_schema_version, NEW.published_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.form_id, OLD.tenant_id, OLD.exam_profile_version_id, OLD.form_type,
         OLD.blueprint_conformance, OLD.blueprint_conformance_schema_version, OLD.published_at, OLD.created_at) THEN
    RAISE EXCEPTION 'assessment_published_form_is_immutable: form % was published at %; only its state and window move (D-006)', OLD.form_id, OLD.published_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD.state, NEW.state) NOT IN (('published', 'embargoed'), ('embargoed', 'active'), ('active', 'closed')) THEN
    RAISE EXCEPTION 'assessment_form_transition_prohibited: form % cannot move % -> %', OLD.form_id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state <> 'published' AND ROW(NEW.opens_at, NEW.closes_at) IS DISTINCT FROM ROW(OLD.opens_at, OLD.closes_at) THEN
    RAISE EXCEPTION 'assessment_form_window_is_fixed: form % was scheduled and its window does not move', OLD.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

ALTER TABLE assessment.form DROP CONSTRAINT form_session_key;
ALTER TABLE assessment.form DROP CONSTRAINT form_session_ref_not_blank;
ALTER TABLE assessment.form DROP COLUMN session_ref;

-- ── publication: every sitting's exposure is counted ────────────────────────

CREATE OR REPLACE FUNCTION assessment.guard_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  slot_count integer;
  anchor_count integer;
  disagreeing integer;
  session_count integer;
  ledger_count integer;
BEGIN
  IF NEW.blueprint_conformance ->> 'satisfied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'assessment_publication_requires_conformance: form % does not satisfy its blueprint', NEW.form_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO session_count FROM assessment.form_session WHERE form_id = NEW.form_id;
  IF session_count = 0 THEN
    RAISE EXCEPTION 'assessment_publication_requires_a_session: form % names no session to be sat in', NEW.form_id
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
  IF ledger_count <> slot_count * session_count THEN
    RAISE EXCEPTION 'assessment_publication_requires_ledger: form % has % ledger row(s) for % slot(s) in % session(s)', NEW.form_id, ledger_count, slot_count, session_count
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON assessment.form_session TO questionbank_app;
    REVOKE TRUNCATE ON assessment.form_session FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- A structural revert: the legacy columns come back nullable and carry no data. A full revert drops the
-- schema, which is what the test harness runs; the function bodies the later migrations replaced are
-- replaced again by reverting those.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'attempt') THEN
    ALTER TABLE assessment.attempt DROP CONSTRAINT IF EXISTS attempt_session_is_one_the_form_was_published_for;
    ALTER TABLE assessment.attempt DROP COLUMN IF EXISTS session_ref;
    ALTER TABLE assessment.attempt ADD COLUMN IF NOT EXISTS session_id uuid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'exposure_ledger_entry') THEN
    ALTER TABLE assessment.exposure_ledger_entry DROP CONSTRAINT IF EXISTS exposure_ledger_matches_session;
    ALTER TABLE assessment.exposure_ledger_entry DROP CONSTRAINT IF EXISTS exposure_ledger_one_row_per_slot_per_session;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form') THEN
    ALTER TABLE assessment.form ADD COLUMN IF NOT EXISTS session_ref text;
  END IF;
END $$;
DROP TABLE IF EXISTS assessment.form_session;
