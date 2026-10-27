-- +migrate Up

-- The learning context's first table (M7-12): D-002's thresholds as versioned data, one immutable row per version.
-- Nothing in the context's source carries a threshold; this is where they live (DOMAIN-MODEL 12.2, BACKEND-ARCHITECTURE: thresholds are
-- configuration, not code).
CREATE SCHEMA learning;

CREATE TABLE learning.mastery_rule_set (
  rule_set_id               uuid        PRIMARY KEY,
  -- The taxonomy version the rule set applies to, which is the exam-shaped identifier evidence carries. NULL is the platform default,
  -- used where nothing is published for the taxonomy.
  taxonomy_version_id       uuid,
  version_no                integer     NOT NULL CHECK (version_no >= 1),
  thresholds                jsonb       NOT NULL,
  thresholds_schema_version integer     NOT NULL DEFAULT 1,
  -- SHA-256 of the canonical JSON of `thresholds`; a transition names the rule set it was decided under by this.
  thresholds_hash           text        NOT NULL CHECK (thresholds_hash ~ '^[0-9a-f]{64}$'),
  authored_by_kind          text        NOT NULL CHECK (authored_by_kind IN ('human', 'ai_agent', 'system')),
  authored_by_id            uuid        NOT NULL,
  created_at                timestamptz NOT NULL
);

-- One version number per scope, counting NULL as a scope of its own.
CREATE UNIQUE INDEX mastery_rule_set_scope_version
  ON learning.mastery_rule_set (COALESCE(taxonomy_version_id, '00000000-0000-0000-0000-000000000000'::uuid), version_no);

-- Published means immutable: a threshold change is a new version, never an edit, or history would be restated under it.
CREATE FUNCTION learning.reject_rule_set_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_mastery_rule_set_is_immutable: % on %; publish a new version instead', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER mastery_rule_set_immutable
  BEFORE UPDATE OR DELETE ON learning.mastery_rule_set
  FOR EACH ROW EXECUTE FUNCTION learning.reject_rule_set_mutation();

-- The platform default: D-002 as written (DOMAIN-MODEL 12.2) plus the three values it does not give (DEC-M7-7). The same numbers are in
-- `src/testing/learning-thresholds.ts`, and a spec holds the two to each other and the hash to the TypeScript that computes it.
INSERT INTO learning.mastery_rule_set
  (rule_set_id, taxonomy_version_id, version_no, thresholds, thresholds_hash, authored_by_kind, authored_by_id, created_at)
VALUES (
  '00000000-0000-4000-8000-0000000000d2',
  NULL,
  1,
  '{"promotion":{"minResponses":8,"minDistinctItems":4,"minDistinctSessions":2,"recentWindow":8,"minRecentAccuracy":0.8,"minRecentAtDemonstratedBand":3},
    "verification":{"minVerifyingResponses":2,"minGapHours":48},
    "session":{"idleGapMinutes":30},
    "states":{"weakBelowAccuracy":0.5},
    "decay":{"halfLifeDays":60,"confidenceFloor":0.5}}'::jsonb,
  '239de260cd11de61364091db7cf5276b7eeef8def2ed8b97aaac0f1416db1ef7',
  'system',
  '00000000-0000-4000-8000-0000000000d2',
  '2026-10-28T00:00:00Z'
);

-- Publishing a rule set is audited through the same chain as every other consequential command; its CHECK named five contexts.
ALTER TABLE platform.audit_record DROP CONSTRAINT audit_record_target_context_check;
ALTER TABLE platform.audit_record
  ADD CONSTRAINT audit_record_target_context_check
  CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation', 'assessment', 'learning'));

-- +migrate Down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'audit_record') THEN
    ALTER TABLE platform.audit_record DROP CONSTRAINT IF EXISTS audit_record_target_context_check;
    ALTER TABLE platform.audit_record
      ADD CONSTRAINT audit_record_target_context_check
      CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation', 'assessment')) NOT VALID;
  END IF;
END $$;

DROP SCHEMA IF EXISTS learning CASCADE;
