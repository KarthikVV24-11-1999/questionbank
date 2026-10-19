-- AIBudget, enforced at enqueue (M5-41, AI-ARCHITECTURE §14, DEC-M5-9).
--
-- "Budget checked at enqueue, before dispatch: checking after billing is
-- accounting, not governance." A run is admitted against a budget when it is
-- enqueued, and a run that would not fit never starts — nothing is spent, and
-- the refusal says why.
--
--   ai_budget                  one row per feature and period: the ceiling, in
--                              tokens, that runs enqueued in that period may
--                              reserve between them, and who declared it. A
--                              period with no row has no budget, and a run
--                              against it is refused (fail closed): the absence
--                              of a ceiling is not an unlimited one.
--   generation_run.budget_tokens
--                              the run's reservation. The run IS the record of
--                              what was reserved, so the reservation cannot
--                              drift from the run it belongs to, and it is as
--                              immutable as the run.
--
-- The unit is tokens, not currency: a provider reports tokens, and a price per
-- token is a registry fact this milestone does not build (D47).
--
-- Both are append-only, under the rule every other `ai` table carries
-- (20260901110000): a row trigger refusing UPDATE and DELETE from every role,
-- and an application role holding SELECT and INSERT only.

-- +migrate Up

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.generation_run) THEN
    RAISE EXCEPTION 'ai_budget_refuses_existing_runs: % run(s) predate budgets; decide what each reserved before adding the column',
      (SELECT count(*) FROM ai.generation_run);
  END IF;
END $$;

ALTER TABLE ai.generation_run
  ADD COLUMN budget_tokens bigint NOT NULL CHECK (budget_tokens > 0);

CREATE TABLE ai.ai_budget (
  budget_id       uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id       uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  feature         text NOT NULL CHECK (length(btrim(feature)) > 0),
  -- UTC calendar month, 'YYYY-MM'.
  period          text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ceiling_tokens  bigint NOT NULL CHECK (ceiling_tokens > 0),
  declared_by_kind text NOT NULL CHECK (declared_by_kind IN ('human', 'system')),
  declared_by_id  uuid NOT NULL,
  declared_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A period's ceiling is fixed once declared. Raising it mid-period is a
  -- decision this milestone does not build (D48).
  CONSTRAINT ai_budget_feature_period_key UNIQUE (feature, period)
);

CREATE INDEX generation_run_requested_at_idx ON ai.generation_run (requested_at);

CREATE TRIGGER ai_budget_append_only
  BEFORE UPDATE OR DELETE ON ai.ai_budget
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT ON ai.ai_budget TO questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.ai_budget FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Guarded on what it touches existing: `revertMigrations()` runs every down
-- script against whatever state it finds.
DROP TABLE IF EXISTS ai.ai_budget;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = 'generation_run') THEN
    DROP INDEX IF EXISTS ai.generation_run_requested_at_idx;
    ALTER TABLE ai.generation_run DROP COLUMN IF EXISTS budget_tokens;
  END IF;
END $$;
