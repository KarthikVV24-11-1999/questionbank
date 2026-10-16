-- §9 rule 11 for the version registry: a published version is never rewritten.
-- A model or prompt version that could be edited after the fact would re-label
-- every run and candidate pinned to it. Same two controls as the rest of `ai`
-- (20260901110000): a row trigger refusing UPDATE and DELETE from every role,
-- and an application role holding SELECT and INSERT only.

-- +migrate Up

CREATE TRIGGER model_version_append_only
  BEFORE UPDATE OR DELETE ON ai.model_version
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER prompt_version_append_only
  BEFORE UPDATE OR DELETE ON ai.prompt_version
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT ON ai.model_version, ai.prompt_version TO questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.model_version FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.prompt_version FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = 'model_version') THEN
    DROP TRIGGER IF EXISTS model_version_append_only ON ai.model_version;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = 'prompt_version') THEN
    DROP TRIGGER IF EXISTS prompt_version_append_only ON ai.prompt_version;
  END IF;
END $$;
