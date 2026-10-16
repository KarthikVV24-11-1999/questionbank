-- A candidate carries its confidence (M5-13). Content's AI provenance refuses
-- `ai_generated` without a confidence in [0, 1], and generation had no source
-- for one, so a candidate could not be turned into a draft.
--
-- The range is refused here and in the domain, the same number two ways. NaN
-- sorts above every number in Postgres, so `<= 1` refuses it as well.
--
-- NOT NULL with no default, deliberately: there is no honest value to
-- backfill, and a default would be exactly the invented number this column
-- exists to prevent. The table has no writers before this migration, so it is
-- empty; if it were not, this statement would fail loudly rather than guess.

-- +migrate Up

ALTER TABLE ai.generation_candidate
  ADD COLUMN confidence double precision NOT NULL,
  ADD CONSTRAINT generation_candidate_confidence_in_unit_interval
    CHECK (confidence >= 0 AND confidence <= 1);

-- +migrate Down

ALTER TABLE IF EXISTS ai.generation_candidate
  DROP CONSTRAINT IF EXISTS generation_candidate_confidence_in_unit_interval,
  DROP COLUMN IF EXISTS confidence;
