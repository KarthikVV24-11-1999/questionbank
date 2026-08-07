-- Scoring context physical schema (DOMAIN-MODEL §7).
-- Patterns applied: P6 UUIDv7 keys, P7 tenant_id, P8 aggregate_version.
--
-- Fitness:
--   F5  every JSONB column has a sibling *_schema_version
--   F47 every item outcome carries a rule_applied_id — enforced here as NOT
--       NULL with a non-empty check, so the database refuses an unexplainable
--       outcome even if some future code path forgets to
--   §9 rule 3: no foreign key crosses a schema boundary. exam_profile_version_id
--       and marking_rule_set_hash are carried as values, not references — a
--       score is pinned to what those were, not to what they are now.

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS scoring;

-- Same time-ordered identifiers as curriculum (P6), owned by this schema so
-- the two can be migrated independently.
CREATE OR REPLACE FUNCTION scoring.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes PLACING unix_ts_ms FROM 1 FOR 6);
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$;

CREATE TABLE scoring.score_record (
  score_record_id             uuid PRIMARY KEY DEFAULT scoring.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  attempt_id                  uuid        NOT NULL,
  exam_profile_version_id     uuid        NOT NULL,
  marking_rule_set_hash       text        NOT NULL CHECK (length(btrim(marking_rule_set_hash)) > 0),
  rule_schema_version         integer     NOT NULL CHECK (rule_schema_version > 0),
  taxonomy_version_id         uuid        NOT NULL,
  generation                  integer     NOT NULL CHECK (generation > 0),
  is_current                  boolean     NOT NULL DEFAULT true,
  supersedes_score_record_id  uuid        REFERENCES scoring.score_record (score_record_id),
  rescoring_operation_id      uuid,
  reason_for_rescore          text,
  total_raw                   numeric(14, 4) NOT NULL,
  total_max_available         numeric(14, 4) NOT NULL CHECK (total_max_available >= 0),
  total_attempted_count       integer     NOT NULL CHECK (total_attempted_count >= 0),
  total_correct_count         integer     NOT NULL CHECK (total_correct_count >= 0),
  total_incorrect_count       integer     NOT NULL CHECK (total_incorrect_count >= 0),
  total_negative_marks        numeric(14, 4) NOT NULL CHECK (total_negative_marks >= 0),
  computed_at                 timestamptz NOT NULL,
  aggregate_version           integer     NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),

  -- The original supersedes nothing; a re-score must say what it replaced.
  CONSTRAINT score_record_generation_supersedes
    CHECK ((generation = 1) = (supersedes_score_record_id IS NULL)),
  -- A change to a published result must be accountable.
  CONSTRAINT score_record_rescore_has_reason
    CHECK (generation = 1 OR (reason_for_rescore IS NOT NULL AND length(btrim(reason_for_rescore)) > 0))
);

-- INV-11: exactly one current record per attempt. A partial unique index makes
-- a second current record impossible rather than merely discouraged, and
-- superseded generations remain in the table untouched.
CREATE UNIQUE INDEX score_record_one_current_per_attempt
  ON scoring.score_record (attempt_id) WHERE is_current;

CREATE UNIQUE INDEX score_record_attempt_generation_key
  ON scoring.score_record (attempt_id, generation);

CREATE INDEX score_record_rescoring_operation_idx
  ON scoring.score_record (rescoring_operation_id) WHERE rescoring_operation_id IS NOT NULL;

CREATE TABLE scoring.section_score (
  score_record_id        uuid    NOT NULL REFERENCES scoring.score_record (score_record_id) ON DELETE CASCADE,
  section_ordinal        integer NOT NULL CHECK (section_ordinal > 0),
  raw                    numeric(14, 4) NOT NULL,
  max_available          numeric(14, 4) NOT NULL CHECK (max_available >= 0),
  attempted_count        integer NOT NULL CHECK (attempted_count >= 0),
  correct_count          integer NOT NULL CHECK (correct_count >= 0),
  incorrect_count        integer NOT NULL CHECK (incorrect_count >= 0),
  negative_marks         numeric(14, 4) NOT NULL CHECK (negative_marks >= 0),
  PRIMARY KEY (score_record_id, section_ordinal)
);

CREATE TABLE scoring.item_outcome (
  item_outcome_id                  uuid PRIMARY KEY DEFAULT scoring.uuid_generate_v7(),
  score_record_id                  uuid NOT NULL REFERENCES scoring.score_record (score_record_id) ON DELETE CASCADE,
  slot_id                          text NOT NULL CHECK (length(btrim(slot_id)) > 0),
  slot_ordinal                     integer NOT NULL CHECK (slot_ordinal > 0),
  section_ordinal                  integer NOT NULL CHECK (section_ordinal > 0),
  item_version_id                  uuid NOT NULL,
  response_snapshot                jsonb,
  response_snapshot_schema_version integer NOT NULL DEFAULT 1,
  correctness                      text NOT NULL
                                     CHECK (correctness IN ('correct', 'incorrect', 'unattempted',
                                                            'dropped', 'bonus', 'indeterminate')),
  marks_awarded                    numeric(14, 4) NOT NULL,
  marks_available                  numeric(14, 4) NOT NULL CHECK (marks_available >= 0),
  -- F47 at the database: an outcome nobody can explain cannot be stored.
  rule_applied_id                  text NOT NULL CHECK (length(btrim(rule_applied_id)) > 0),
  rule_applied_explanation         text NOT NULL CHECK (length(btrim(rule_applied_explanation)) > 0),

  CONSTRAINT item_outcome_slot_unique UNIQUE (score_record_id, slot_id)
);

CREATE INDEX item_outcome_score_record_idx ON scoring.item_outcome (score_record_id);

CREATE TABLE scoring.rescoring_operation (
  rescoring_operation_id         uuid PRIMARY KEY DEFAULT scoring.uuid_generate_v7(),
  tenant_id                      uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  trigger                        text NOT NULL
                                   CHECK (trigger IN ('CHALLENGE_UPHELD', 'KEY_DEFECT_CONFIRMED', 'RULE_CORRECTION')),
  scope                          text NOT NULL
                                   CHECK (scope IN ('ITEM_VERSION', 'RULE_CHANGE', 'FORM')),
  scope_ref                      text NOT NULL CHECK (length(btrim(scope_ref)) > 0),
  reason                         text NOT NULL CHECK (length(btrim(reason)) > 0),
  state                          text NOT NULL DEFAULT 'drafted'
                                   CHECK (state IN ('drafted', 'previewed', 'approved', 'executing', 'completed')),
  dry_run_result                 jsonb,
  dry_run_result_schema_version  integer NOT NULL DEFAULT 1,
  authorized_by_kind             text CHECK (authorized_by_kind IN ('human', 'ai_agent', 'system')),
  authorized_by_id               uuid,
  executed_at                    timestamptz,
  aggregate_version              integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                     timestamptz NOT NULL DEFAULT now(),

  -- The dry run is the gate: approval is unreachable without a preview.
  CONSTRAINT rescoring_operation_approval_needs_preview
    CHECK (state IN ('drafted', 'previewed') OR dry_run_result IS NOT NULL),
  CONSTRAINT rescoring_operation_approval_needs_principal
    CHECK (state IN ('drafted', 'previewed') OR authorized_by_id IS NOT NULL),
  CONSTRAINT rescoring_operation_completion_stamped
    CHECK ((state = 'completed') = (executed_at IS NOT NULL))
);

CREATE INDEX rescoring_operation_state_idx ON scoring.rescoring_operation (tenant_id, state);

-- +migrate Down

DROP TABLE IF EXISTS scoring.rescoring_operation;
DROP TABLE IF EXISTS scoring.item_outcome;
DROP TABLE IF EXISTS scoring.section_score;
DROP TABLE IF EXISTS scoring.score_record;
DROP FUNCTION IF EXISTS scoring.uuid_generate_v7();
DROP SCHEMA IF EXISTS scoring;
