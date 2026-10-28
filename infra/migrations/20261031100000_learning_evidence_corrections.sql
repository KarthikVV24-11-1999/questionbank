-- A re-score corrects an outcome; Learning keeps both (D72, M7-40).
--
-- Evidence is history and is never edited, and a transition is history and is never deleted. When a re-score changes what a response was worth, the original
-- row stays exactly as it was and the correction is a row of its own beside it: what a response counts as *now* is its latest correction if it has one, and
-- what it was first recorded as if it does not. A correction can also say a response no longer counts at all (`withdrawn`), which is what it is when a rule
-- change drops a question from the paper.
--
-- A promotion granted on an outcome that was later corrected cannot be allowed to stand, and cannot be deleted either: a revocation is a row beside it. The
-- transition is kept, with the responses it was made on, and a reader that asks where a concept stands does not see it.

-- +migrate Up

CREATE TABLE learning.evidence_correction (
  correction_seq bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_id    uuid        NOT NULL REFERENCES learning.mastery_evidence (evidence_id),
  outcome        text        NOT NULL CHECK (outcome IN ('correct', 'incorrect', 'withdrawn')),
  recorded_at    timestamptz NOT NULL
);

CREATE INDEX evidence_correction_latest ON learning.evidence_correction (evidence_id, correction_seq DESC);

CREATE TABLE learning.transition_revocation (
  transition_id uuid        PRIMARY KEY REFERENCES learning.mastery_transition (transition_id),
  revoked_at    timestamptz NOT NULL
);

CREATE FUNCTION learning.reject_correction_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_correction_is_history: % on % refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER evidence_correction_append_only
  BEFORE UPDATE OR DELETE ON learning.evidence_correction
  FOR EACH ROW EXECUTE FUNCTION learning.reject_correction_change();

CREATE TRIGGER transition_revocation_append_only
  BEFORE UPDATE OR DELETE ON learning.transition_revocation
  FOR EACH ROW EXECUTE FUNCTION learning.reject_correction_change();

-- +migrate Down

DROP TABLE IF EXISTS learning.transition_revocation;
DROP TABLE IF EXISTS learning.evidence_correction;
DROP FUNCTION IF EXISTS learning.reject_correction_change();
