-- +migrate Up

-- The review schedule (M7-47): where each concept a learner has evidence for stands in its spaced review. One row per concept, never per item, so there is nothing
-- to memorise a particular question from. Like `concept_state` it is derived, from the evidence and the rule set's `review` values (DEC-M7-24), and recomputed
-- whenever a response of the concept arrives or is corrected, so it is traceable to evidence and a re-score reaches it.
CREATE TABLE learning.review_schedule (
  learner_ref            uuid        NOT NULL,
  taxonomy_version_id    uuid        NOT NULL,
  concept_identity_id    uuid        NOT NULL,
  due_at                 timestamptz NOT NULL,
  interval_days          integer     NOT NULL CHECK (interval_days >= 1),
  consecutive_successes  integer     NOT NULL CHECK (consecutive_successes >= 0),
  lapse_count            integer     NOT NULL CHECK (lapse_count >= 0),
  last_observed_at       timestamptz NOT NULL,
  rule_set_id            uuid        NOT NULL REFERENCES learning.mastery_rule_set (rule_set_id),
  PRIMARY KEY (learner_ref, taxonomy_version_id, concept_identity_id)
);

CREATE INDEX review_schedule_due ON learning.review_schedule (learner_ref, due_at);

-- +migrate Down

DROP TABLE IF EXISTS learning.review_schedule;
