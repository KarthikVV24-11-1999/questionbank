-- +migrate Up

-- The learner profile (M8-18, FR-STU-01, FR-STU-02): what the learner says of themselves, and which part of the syllabus they have studied. One row per learner, keyed on the
-- identifier Identity issued; there is no foreign key into Identity's tables, because the two contexts stay separate and a user id is a value the shared kernel already carries.
--
-- **Partial from the start.** A profile mid-onboarding is a real state: every field but the key may be empty, and the table says only what must hold together. The exam and the year
-- are chosen together; the exam profile version and taxonomy version are what the choice resolved to *when it was made* and are kept, as the evidence rows keep the item version (D70),
-- so that a rule that changes later recomputes against what was chosen rather than asking the learner again (INV-04). A scope is declared against one taxonomy version, the whole of
-- it: the chapters picked, the concepts they stand for, and how many concepts the version had, which is the denominator of the coverage a learner is shown.
CREATE TABLE learning.learner_profile (
  learner_ref                 uuid        PRIMARY KEY,
  exam_code                   text        CHECK (exam_code IS NULL OR length(btrim(exam_code)) > 0),
  target_year                 text        CHECK (target_year IS NULL OR target_year ~ '^[0-9]{4}(-[0-9]{2})?$'),
  exam_profile_version_id     uuid,
  taxonomy_version_id         uuid,
  current_class               text        CHECK (current_class IN ('class_11', 'class_12', 'repeater')),
  prior_score_value           numeric,
  prior_score_out_of          numeric,
  scope_taxonomy_version_id   uuid,
  scope_node_ids              uuid[],
  scope_concept_ids           uuid[],
  scope_concept_total         integer,
  onboarding_skipped_at       timestamptz,
  version                     integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  CONSTRAINT learner_profile_exam_and_year_together CHECK ((exam_code IS NULL) = (target_year IS NULL)),
  CONSTRAINT learner_profile_resolution_needs_an_exam CHECK ((exam_profile_version_id IS NULL AND taxonomy_version_id IS NULL) OR (exam_code IS NOT NULL AND exam_profile_version_id IS NOT NULL AND taxonomy_version_id IS NOT NULL)),
  CONSTRAINT learner_profile_prior_score_whole CHECK ((prior_score_value IS NULL) = (prior_score_out_of IS NULL)),
  CONSTRAINT learner_profile_prior_score_in_range CHECK (prior_score_value IS NULL OR (prior_score_out_of > 0 AND prior_score_value >= 0 AND prior_score_value <= prior_score_out_of)),
  CONSTRAINT learner_profile_scope_whole CHECK (
    (scope_taxonomy_version_id IS NULL AND scope_node_ids IS NULL AND scope_concept_ids IS NULL AND scope_concept_total IS NULL)
    OR (scope_taxonomy_version_id IS NOT NULL AND scope_node_ids IS NOT NULL AND scope_concept_ids IS NOT NULL AND scope_concept_total IS NOT NULL)
  ),
  CONSTRAINT learner_profile_scope_in_range CHECK (scope_concept_total IS NULL OR (scope_concept_total >= 1 AND cardinality(scope_concept_ids) <= scope_concept_total))
);

-- +migrate Down

DROP TABLE IF EXISTS learning.learner_profile;
