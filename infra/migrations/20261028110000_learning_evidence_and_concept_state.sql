-- +migrate Up

-- Mastery evidence, durable (M7-14). DOMAIN-MODEL 9 keeps "a bounded window inline" in the aggregate; that is the aggregate's shape and not its storage.
-- M7's first acceptance line is that every concept state is traceable to the specific responses that produced it, and a bounded window cannot be
-- that on its own. One row per response that counted.
CREATE TABLE learning.mastery_evidence (
  evidence_id          uuid        PRIMARY KEY,
  learner_ref          uuid        NOT NULL,
  attempt_ref          uuid        NOT NULL,
  slot_ref             text        NOT NULL CHECK (length(btrim(slot_ref)) > 0),
  -- The version is retained so a rule that credits more than the primary concept can recompute from history (D70).
  item_version_ref     uuid        NOT NULL,
  concept_identity_id  uuid        NOT NULL,
  taxonomy_version_id  uuid        NOT NULL,
  outcome              text        NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  -- An author's estimate and not a measured value (D71).
  difficulty_estimate  text        NOT NULL CHECK (difficulty_estimate IN ('foundational', 'moderate', 'challenging', 'advanced')),
  -- The instant of the response (M7-11); `scored_at` is the instant the attempt was scored. A response cannot follow the score that counted it.
  occurred_at          timestamptz NOT NULL,
  scored_at            timestamptz NOT NULL,
  -- The learner's sitting this response was placed in (DEC-M7-2). It is assigned in the transaction that stores the row, so no row is ever committed
  -- without one; and it is the one column that may change after the row is written, when a late response bridges two sittings into one.
  study_session_id     uuid,
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT mastery_evidence_response_precedes_score CHECK (occurred_at <= scored_at),
  -- One response per slot of an attempt: this is what makes a second delivery of the same event a no-op.
  CONSTRAINT mastery_evidence_one_per_slot UNIQUE (attempt_ref, slot_ref)
);

CREATE INDEX mastery_evidence_by_concept ON learning.mastery_evidence (learner_ref, taxonomy_version_id, concept_identity_id, occurred_at);
CREATE INDEX mastery_evidence_by_session ON learning.mastery_evidence (study_session_id);

-- Evidence is history: it is never edited or deleted. The session assignment is the one exception, and the guard names it.
CREATE FUNCTION learning.guard_mastery_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning_mastery_evidence_is_history: DELETE refused' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'study_session_id') IS DISTINCT FROM (to_jsonb(OLD) - 'study_session_id') THEN
    RAISE EXCEPTION 'learning_mastery_evidence_is_history: only study_session_id may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mastery_evidence_guarded
  BEFORE UPDATE OR DELETE ON learning.mastery_evidence
  FOR EACH ROW EXECUTE FUNCTION learning.guard_mastery_evidence();

-- A learner's sittings (DEC-M7-2). Their extent moves as late responses extend or bridge them; they hold no content of their own.
CREATE TABLE learning.study_session (
  session_id  uuid        PRIMARY KEY,
  learner_ref uuid        NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL,
  CONSTRAINT study_session_extent CHECK (started_at <= ended_at)
);

CREATE INDEX study_session_by_learner ON learning.study_session (learner_ref, started_at);

-- Where a learner stands on a concept (D-007): updated in place, and always rebuildable from the evidence rows. It records the rule set it was
-- derived under, and the instant the derivation was computed against, which is when evidence last arrived and not when a job ran: decay is
-- computed at read (DEC-M7-8), so nothing here goes stale.
CREATE TABLE learning.concept_state (
  learner_ref                   uuid             NOT NULL,
  taxonomy_version_id           uuid             NOT NULL,
  concept_identity_id           uuid             NOT NULL,
  state                         text             NOT NULL CHECK (state IN ('unassessed', 'weak', 'developing', 'strong')),
  raw_state                     text             NOT NULL CHECK (raw_state IN ('unassessed', 'weak', 'developing', 'strong')),
  confidence                    double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  base_confidence               double precision NOT NULL CHECK (base_confidence >= 0 AND base_confidence <= 1),
  low_confidence                boolean          NOT NULL,
  evidence_count                integer          NOT NULL CHECK (evidence_count >= 0),
  distinct_item_count           integer          NOT NULL CHECK (distinct_item_count >= 0),
  distinct_session_count        integer          NOT NULL CHECK (distinct_session_count >= 0),
  last_evidence_at              timestamptz,
  difficulty_band_demonstrated  text             CHECK (difficulty_band_demonstrated IN ('foundational', 'moderate', 'challenging', 'advanced')),
  decay_applied_at              timestamptz      NOT NULL,
  rule_set_id                   uuid             NOT NULL REFERENCES learning.mastery_rule_set (rule_set_id),
  PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id)
);

-- +migrate Down

DROP TABLE IF EXISTS learning.concept_state;
DROP TABLE IF EXISTS learning.study_session;
DROP TABLE IF EXISTS learning.mastery_evidence;
DROP FUNCTION IF EXISTS learning.guard_mastery_evidence();
