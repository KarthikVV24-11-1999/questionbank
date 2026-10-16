-- §9 rule 11 on the generation context: every table in `ai` is append-only.
--
-- A candidate's recorded verdicts are the audit trail the whole pre-check
-- battery rests on (AI-ARCHITECTURE §11): "this candidate passed the
-- answer-verification check" is only worth anything if nobody can later make
-- it say something else. So nothing here is ever updated or deleted, by
-- anyone, and the application role does not hold the privileges to try.
--
-- Two controls, deliberately both:
--   * a row trigger refuses UPDATE and DELETE from every role, the owner
--     included — reusing `platform.reject_any_mutation()` rather than a second
--     copy of the same unconditional refusal, as the review tables do;
--   * the application role is granted SELECT and INSERT only. TRUNCATE is the
--     one path a row trigger cannot see, so there the grant is the control —
--     and it is never named.
--
-- The role migration (M0-24) pre-dates this schema, so its schema-wide grants
-- did not reach `ai`; the grants below are this schema's own, and the default
-- privileges make a future `ai` table append-only for the application role
-- until someone decides otherwise.

-- +migrate Up

CREATE TRIGGER generation_run_append_only
  BEFORE UPDATE OR DELETE ON ai.generation_run
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER generation_candidate_append_only
  BEFORE UPDATE OR DELETE ON ai.generation_candidate
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER candidate_verdict_append_only
  BEFORE UPDATE OR DELETE ON ai.candidate_verdict
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER candidate_decision_append_only
  BEFORE UPDATE OR DELETE ON ai.candidate_decision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- Conditional because the role is created by the deployment (M0-24 locally); a
-- database without it yet is not a broken migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT USAGE ON SCHEMA ai TO questionbank_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ai TO questionbank_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT SELECT, INSERT ON TABLES TO questionbank_app;
    -- Named explicitly as well, so the refusal does not rest on what a
    -- default happened to be when the table was created.
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.generation_run FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.generation_candidate FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.candidate_verdict FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.candidate_decision FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Safe no-op against a schema-less database: every statement is guarded on the
-- thing it touches existing, since `revertMigrations()` runs every down script
-- against whatever state the database happens to be in.
DO $$
DECLARE
  target text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'ai') THEN
    FOREACH target IN ARRAY ARRAY['generation_run', 'generation_candidate', 'candidate_verdict', 'candidate_decision']
    LOOP
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = target) THEN
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON ai.%I', target || '_append_only', target);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
      ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE SELECT, INSERT ON TABLES FROM questionbank_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM questionbank_app;
      REVOKE USAGE ON SCHEMA ai FROM questionbank_app;
    END IF;
  END IF;
END
$$;
