-- +migrate Up

-- Escalation (M7-48, DEC-M7-25): a concept that keeps lapsing stops being repeated and becomes a remediation finding. The primary key is what makes it exactly one:
-- a concept escalates once, and a delivery that finds it escalated already writes nothing. A row is history and is never changed.
CREATE TABLE learning.review_escalation (
  learner_ref          uuid        NOT NULL,
  taxonomy_version_id  uuid        NOT NULL,
  concept_identity_id  uuid        NOT NULL,
  escalated_at         timestamptz NOT NULL,
  lapse_count          integer     NOT NULL CHECK (lapse_count >= 1),
  rule_set_id          uuid        NOT NULL REFERENCES learning.mastery_rule_set (rule_set_id),
  PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id)
);

CREATE FUNCTION learning.reject_escalation_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_escalation_is_history: % on % refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER review_escalation_append_only BEFORE UPDATE OR DELETE ON learning.review_escalation FOR EACH ROW EXECUTE FUNCTION learning.reject_escalation_change();

-- +migrate Down

DROP TABLE IF EXISTS learning.review_escalation;
DROP FUNCTION IF EXISTS learning.reject_escalation_change();
