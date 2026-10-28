-- The diagnostic report (M7-42): one per scored attempt per score record, never edited. A re-score produces a report of its own, so the learner's history of what
-- they were told is itself a record (D3).

-- +migrate Up

CREATE TABLE learning.diagnostic_report (
  report_id        uuid        PRIMARY KEY,
  learner_ref      uuid        NOT NULL,
  attempt_ref      uuid        NOT NULL,
  score_record_ref uuid        NOT NULL,
  generated_at     timestamptz NOT NULL,
  report_seq       bigint      GENERATED ALWAYS AS IDENTITY,
  -- The same score record reported twice is one report: this is what makes a redelivered event a no-op.
  CONSTRAINT diagnostic_report_one_per_score UNIQUE (attempt_ref, score_record_ref)
);

CREATE INDEX diagnostic_report_by_attempt ON learning.diagnostic_report (learner_ref, attempt_ref, report_seq DESC);

CREATE TABLE learning.report_finding (
  report_id           uuid          NOT NULL REFERENCES learning.diagnostic_report (report_id),
  rank                integer       NOT NULL CHECK (rank >= 1),
  concept_identity_id uuid          NOT NULL,
  taxonomy_version_id uuid          NOT NULL,
  marks_lost          numeric(14,4) NOT NULL CHECK (marks_lost > 0),
  marks_available     numeric(14,4) NOT NULL,
  slot_count          integer       NOT NULL CHECK (slot_count >= 1),
  skipped_count       integer       NOT NULL CHECK (skipped_count >= 0 AND skipped_count <= slot_count),
  PRIMARY KEY (report_id, rank)
);

CREATE FUNCTION learning.reject_report_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_report_is_history: % on % refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER diagnostic_report_append_only BEFORE UPDATE OR DELETE ON learning.diagnostic_report FOR EACH ROW EXECUTE FUNCTION learning.reject_report_change();
CREATE TRIGGER report_finding_append_only BEFORE UPDATE OR DELETE ON learning.report_finding FOR EACH ROW EXECUTE FUNCTION learning.reject_report_change();

-- +migrate Down

DROP TABLE IF EXISTS learning.report_finding;
DROP TABLE IF EXISTS learning.diagnostic_report;
DROP FUNCTION IF EXISTS learning.reject_report_change();
