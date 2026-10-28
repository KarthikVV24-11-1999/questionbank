-- An escalation can be resolved (D85, DEC-M7-27). The escalation is history and is never changed; the resolution is a row beside it, as a revocation sits beside a
-- transition. An escalation with no resolution is open, and `learning.open_review_escalation` is the one place that says so: what is due, what a targeted run
-- is about and what a learner is shown all read it, so they cannot disagree about which escalations still stand.
--
-- A concept can be escalated again once its earlier escalation is resolved, so the escalation's key now includes the instant it was made: a concept has at most
-- one open escalation (the writer does not make a second while one stands), and any number of resolved ones.

-- +migrate Up

ALTER TABLE learning.review_escalation DROP CONSTRAINT review_escalation_pkey;
ALTER TABLE learning.review_escalation ADD PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at);

CREATE TABLE learning.review_escalation_resolution (
  learner_ref          uuid        NOT NULL,
  taxonomy_version_id  uuid        NOT NULL,
  concept_identity_id  uuid        NOT NULL,
  escalated_at         timestamptz NOT NULL,
  resolved_at          timestamptz NOT NULL,
  reason               text        NOT NULL CHECK (reason IN ('recovered', 'lapses_corrected')),
  rule_set_id          uuid        NOT NULL REFERENCES learning.mastery_rule_set (rule_set_id),
  PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at),
  FOREIGN KEY (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at)
    REFERENCES learning.review_escalation (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at)
);

CREATE TRIGGER review_escalation_resolution_append_only
  BEFORE UPDATE OR DELETE ON learning.review_escalation_resolution
  FOR EACH ROW EXECUTE FUNCTION learning.reject_escalation_change();

CREATE VIEW learning.open_review_escalation AS
  SELECT e.learner_ref, e.taxonomy_version_id, e.concept_identity_id, e.escalated_at, e.lapse_count, e.rule_set_id
    FROM learning.review_escalation e
   WHERE NOT EXISTS (
           SELECT 1 FROM learning.review_escalation_resolution r
            WHERE r.learner_ref = e.learner_ref AND r.taxonomy_version_id = e.taxonomy_version_id
              AND r.concept_identity_id = e.concept_identity_id AND r.escalated_at = e.escalated_at);

-- +migrate Down

DROP VIEW IF EXISTS learning.open_review_escalation;
DROP TABLE IF EXISTS learning.review_escalation_resolution;
ALTER TABLE IF EXISTS learning.review_escalation DROP CONSTRAINT IF EXISTS review_escalation_pkey;
ALTER TABLE IF EXISTS learning.review_escalation ADD PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id);
