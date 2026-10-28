-- +migrate Up

-- Version 2 of the platform default (M7-46, M7-47): D-002 as version 1 has it, plus the values the time analytics and the review schedule read (DEC-M7-23,
-- DEC-M7-24). Version 1 is left as it is: transitions were decided under it, and a published version is immutable. `pace` and `review` are absent from it, and
-- the domain reads an absence as "no pace and no schedule under this version" and does not substitute a value.
-- The same numbers are in `src/testing/learning-thresholds.ts`, and a spec holds the two to each other and the hash to the TypeScript that computes it.
INSERT INTO learning.mastery_rule_set
  (rule_set_id, taxonomy_version_id, version_no, thresholds, thresholds_hash, authored_by_kind, authored_by_id, created_at)
VALUES (
  '00000000-0000-4000-8000-0000000000d3',
  NULL,
  2,
  '{"promotion":{"minResponses":8,"minDistinctItems":4,"minDistinctSessions":2,"recentWindow":8,"minRecentAccuracy":0.8,"minRecentAtDemonstratedBand":3},
    "verification":{"minVerifyingResponses":2,"minGapHours":48},
    "session":{"idleGapMinutes":30},
    "states":{"weakBelowAccuracy":0.5},
    "decay":{"halfLifeDays":60,"confidenceFloor":0.5},
    "pace":{"slowAboveMs":{"foundational":60000,"moderate":90000,"challenging":120000,"advanced":150000}},
    "review":{"passAccuracy":0.8,"firstIntervalDays":1,"growthFactor":2,"lapseFactor":0.5,"minIntervalDays":1,"maxIntervalDays":60,"escalateAtLapses":3}}'::jsonb,
  '0afb4db62dc27f716cf6a7dc3cd91eb8fcec7b896044b6a81a721eb6d80afeef',
  'system',
  '00000000-0000-4000-8000-0000000000d2',
  '2026-11-01T00:00:00Z'
);

-- +migrate Down

-- A published version is immutable, and a state or a transition that was decided under this one still names it. Where any does, the row stays: the schema
-- itself is dropped by the first learning migration's Down, which is the only rollback that can take a decided history with it.
DO $$
BEGIN
  -- a database the earlier migrations were already reverted on has no schema to take the row from
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'learning' AND table_name = 'mastery_rule_set') THEN
    ALTER TABLE learning.mastery_rule_set DISABLE TRIGGER mastery_rule_set_immutable;
    BEGIN
      DELETE FROM learning.mastery_rule_set WHERE rule_set_id = '00000000-0000-4000-8000-0000000000d3';
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
    ALTER TABLE learning.mastery_rule_set ENABLE TRIGGER mastery_rule_set_immutable;
  END IF;
END $$;
