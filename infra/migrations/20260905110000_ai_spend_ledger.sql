-- The AI spend ledger (M5-42, DATA-ARCHITECTURE: append-only, attributable).
--
-- One row per provider interaction, written by the meter that wraps the provider
-- (`MeteredProvider`) and by nothing else: what the ledger records is what the
-- budget counts, because a run's consumption is *read from here* rather than kept
-- in a counter beside it that could disagree.
--
-- Attribution is the point. Each row names the model version and prompt version
-- the interaction ran under — for a judged check these are the check's own, not
-- the candidate's — as foreign keys into the registry, so "what did prompt v7
-- cost?" is one indexed query. It names the run the spend is charged to, which is
-- where the reservation was made (20260905100000).
--
-- Tokens, not money (D47). The ledger is not partitioned by month as the data
-- architecture sketches (D49): a partitioned table needs its partitions created
-- ahead of the rows, and a missing one makes the insert — and so the metered call —
-- fail. Deferred, not forgotten.
--
-- Append-only, under the rule every other `ai` table carries (20260901110000): a
-- row trigger refusing UPDATE and DELETE from every role, and an application role
-- holding SELECT and INSERT only.

-- +migrate Up

CREATE TABLE ai.ai_spend_ledger (
  ledger_id         uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  feature           text NOT NULL CHECK (length(btrim(feature)) > 0),
  run_id            uuid NOT NULL REFERENCES ai.generation_run (run_id),
  model_version_id  uuid NOT NULL REFERENCES ai.model_version (model_version_id),
  prompt_version_id uuid NOT NULL REFERENCES ai.prompt_version (prompt_version_id),
  call_kind         text NOT NULL CHECK (call_kind IN ('propose', 'judge')),
  input_tokens      bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens     bigint NOT NULL CHECK (output_tokens >= 0),
  -- Derived by the database, so the total cannot be recorded as something other than the sum.
  total_tokens      bigint GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  occurred_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_spend_ledger_run_idx ON ai.ai_spend_ledger (run_id);
CREATE INDEX ai_spend_ledger_feature_time_idx ON ai.ai_spend_ledger (feature, occurred_at);
CREATE INDEX ai_spend_ledger_prompt_version_idx ON ai.ai_spend_ledger (prompt_version_id);

CREATE TRIGGER ai_spend_ledger_append_only
  BEFORE UPDATE OR DELETE ON ai.ai_spend_ledger
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT ON ai.ai_spend_ledger TO questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.ai_spend_ledger FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS ai.ai_spend_ledger;
