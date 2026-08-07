-- Adds AggregationSpec to the exam profile version (ADR-0006).
--
-- It lives beside the marking rule set rather than inside it, so no published
-- marking_rule_set_hash moves. Existing rows take the default, which is
-- exactly JEE Main's behaviour — sum the sections, sum the total, no rounding,
-- no floor — so every published profile keeps scoring as it always has.
--
-- Fitness: F5 the JSONB column has a sibling *_schema_version.

-- +migrate Up

ALTER TABLE curriculum.exam_profile_version
  ADD COLUMN aggregation jsonb NOT NULL DEFAULT
    '{"sectionAggregation":"SUM","totalAggregation":"SUM_OF_SECTIONS","rounding":{"mode":"NONE","decimalPlaces":0},"floorAtZero":false}'::jsonb,
  ADD COLUMN aggregation_schema_version integer NOT NULL DEFAULT 1;

-- +migrate Down

-- `IF EXISTS` on the table as well as the columns: reverting an already-clean
-- database must be a no-op, exactly as it is for the DROP TABLE migrations
-- either side of this one.
ALTER TABLE IF EXISTS curriculum.exam_profile_version
  DROP COLUMN IF EXISTS aggregation_schema_version,
  DROP COLUMN IF EXISTS aggregation;
