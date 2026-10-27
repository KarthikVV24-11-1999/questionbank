-- +migrate Up

-- The weakest state a concept has been in since it was last strong (DEC-M7-9). A promotion's `from` is this, which is what makes "weak -> strong" mean a
-- weakness turned into a strength and not merely the state the instant before.
ALTER TABLE learning.concept_state
  ADD COLUMN weakest_since_strong text CHECK (weakest_since_strong IN ('unassessed', 'weak', 'developing'));

-- A concept's state changing (M7-15). Appended and never edited, with one exception: a promotion is verified once, later, and that is the only change
-- the table will take. A regression is a row of its own; the gain it reverses is untouched.
CREATE TABLE learning.mastery_transition (
  transition_seq        bigint      GENERATED ALWAYS AS IDENTITY,
  transition_id         uuid        PRIMARY KEY,
  learner_ref           uuid        NOT NULL,
  taxonomy_version_id   uuid        NOT NULL,
  concept_identity_id   uuid        NOT NULL,
  from_state            text        NOT NULL CHECK (from_state IN ('unassessed', 'weak', 'developing', 'strong')),
  to_state              text        NOT NULL CHECK (to_state IN ('unassessed', 'weak', 'developing', 'strong')),
  -- The instant of the response that caused it (M7-11), not of the delivery that carried it.
  occurred_at           timestamptz NOT NULL,
  -- The instant of the response that completed the verification; empty until then, and always empty for a regression.
  verified_at           timestamptz,
  is_regression         boolean     NOT NULL,
  -- The rule set it was decided under (DEC-M7-7); a pending promotion is verified under these, not under whatever is published since.
  rule_set_id           uuid        NOT NULL REFERENCES learning.mastery_rule_set (rule_set_id),
  rule_set_hash         text        NOT NULL CHECK (rule_set_hash ~ '^[0-9a-f]{64}$'),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT mastery_transition_changes_state CHECK (from_state <> to_state),
  CONSTRAINT mastery_transition_regression_is_never_verified CHECK (NOT is_regression OR verified_at IS NULL),
  CONSTRAINT mastery_transition_regression_leaves_strong CHECK (NOT is_regression OR from_state = 'strong'),
  CONSTRAINT mastery_transition_promotion_enters_strong CHECK (is_regression OR to_state = 'strong'),
  CONSTRAINT mastery_transition_verified_after_it_happened CHECK (verified_at IS NULL OR verified_at >= occurred_at)
);

CREATE INDEX mastery_transition_by_concept ON learning.mastery_transition (learner_ref, taxonomy_version_id, concept_identity_id, transition_seq);

-- The responses behind a transition, by role. Qualifying ones are written with the promotion and verifying ones when it is verified.
CREATE TABLE learning.mastery_transition_evidence (
  transition_id uuid NOT NULL REFERENCES learning.mastery_transition (transition_id),
  evidence_id   uuid NOT NULL REFERENCES learning.mastery_evidence (evidence_id),
  role          text NOT NULL CHECK (role IN ('qualifying', 'verifying')),
  PRIMARY KEY (transition_id, evidence_id, role)
);

CREATE FUNCTION learning.guard_mastery_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning_mastery_transition_is_history: DELETE refused' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The one permitted change: an unverified promotion gains the instant it was verified. Nothing else about it moves, and it cannot be undone.
  IF OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL
     AND (to_jsonb(NEW) - 'verified_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'verified_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_mastery_transition_is_history: only an unverified promotion may be verified, once' USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER mastery_transition_guarded
  BEFORE UPDATE OR DELETE ON learning.mastery_transition
  FOR EACH ROW EXECUTE FUNCTION learning.guard_mastery_transition();

CREATE FUNCTION learning.reject_transition_evidence_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_mastery_transition_is_history: % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER mastery_transition_evidence_append_only
  BEFORE UPDATE OR DELETE ON learning.mastery_transition_evidence
  FOR EACH ROW EXECUTE FUNCTION learning.reject_transition_evidence_change();

-- +migrate Down

DROP TABLE IF EXISTS learning.mastery_transition_evidence;
DROP TABLE IF EXISTS learning.mastery_transition;
DROP FUNCTION IF EXISTS learning.reject_transition_evidence_change();
DROP FUNCTION IF EXISTS learning.guard_mastery_transition();
ALTER TABLE IF EXISTS learning.concept_state DROP COLUMN IF EXISTS weakest_since_strong;
