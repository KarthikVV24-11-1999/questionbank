-- The EvaluationRun, and the gate on activating a version (M5-43, F31).
--
-- F31: no model or prompt version activates without a passing evaluation run.
-- A version is *activated* for generation when a run names it, so the gate is on
-- the run: this migration adds the evaluation record, and a trigger on
-- `generation_run` that refuses a run whose model version or prompt version has no
-- passing evaluation. The application checks first and names the version; this is
-- the backstop that makes F31 a fact about the data, so a code path that forgot —
-- or a direct INSERT — cannot activate anything.
--
-- An evaluation run evaluates one version, model or prompt, against a named
-- corpus. Its `outcome` is not typed in by whoever records it: the domain derives
-- it from the scores and the baseline (`evaluate`), and what is stored is the
-- result together with the regressions that decided it. Regression blocks
-- promotion — warn is not sufficient (AI-ARCHITECTURE §14, FR-AI-10) — so a run
-- that regressed is stored as `fail`, and a `fail` is not a pass.
--
-- The trigger below trusts the stored `outcome`. What keeps that honest is that the only writer derives it
-- (`evaluate`) and the table is append-only; nothing in SQL re-derives a pass from the scores, because that
-- would be the same rule in two languages (D51).
--
-- Append-only, under the rule every other `ai` table carries: a row trigger
-- refusing UPDATE and DELETE from every role, an application role holding SELECT
-- and INSERT only. An evaluation that could be edited after the fact could turn a
-- failing version into a passing one.

-- +migrate Up

CREATE TABLE ai.evaluation_run (
  evaluation_run_id uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- Exactly one subject: the model version or the prompt version being evaluated.
  model_version_id  uuid REFERENCES ai.model_version (model_version_id),
  prompt_version_id uuid REFERENCES ai.prompt_version (prompt_version_id),
  corpus            text NOT NULL CHECK (length(btrim(corpus)) > 0),
  -- Dimension -> score in [0, 1]. The vocabulary is closed in the domain; the document is checked to be an object here.
  scores            jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'object'),
  scores_schema_version integer NOT NULL DEFAULT 1 CHECK (scores_schema_version > 0),
  -- The passing run this one was compared against, if any.
  baseline_run_id   uuid REFERENCES ai.evaluation_run (evaluation_run_id),
  -- The dimensions that regressed against the baseline or missed an absolute floor. A pass has none.
  regressions       text[] NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('pass', 'fail')),
  evaluated_by_kind text NOT NULL CHECK (evaluated_by_kind IN ('human', 'system')),
  evaluated_by_id   uuid NOT NULL,
  evaluated_at      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_run_exactly_one_subject
    CHECK ((model_version_id IS NOT NULL) <> (prompt_version_id IS NOT NULL)),
  -- A pass has no regressions; the two columns cannot disagree.
  CONSTRAINT evaluation_run_pass_has_no_regressions
    CHECK (outcome <> 'pass' OR cardinality(regressions) = 0)
);

CREATE INDEX evaluation_run_model_version_idx ON ai.evaluation_run (model_version_id) WHERE outcome = 'pass';
CREATE INDEX evaluation_run_prompt_version_idx ON ai.evaluation_run (prompt_version_id) WHERE outcome = 'pass';

CREATE TRIGGER evaluation_run_append_only
  BEFORE UPDATE OR DELETE ON ai.evaluation_run
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- F31 as a fact about the data. BEFORE INSERT on the run, so the refusal comes before any foreign key
-- is looked at, and it names the version so the caller can say which one.
CREATE FUNCTION ai.require_evaluated_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai.evaluation_run WHERE model_version_id = NEW.model_version_id AND outcome = 'pass'
  ) THEN
    RAISE EXCEPTION 'version_not_evaluated: model version % has no passing evaluation run (F31)', NEW.model_version_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ai.evaluation_run WHERE prompt_version_id = NEW.prompt_version_id AND outcome = 'pass'
  ) THEN
    RAISE EXCEPTION 'version_not_evaluated: prompt version % has no passing evaluation run (F31)', NEW.prompt_version_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER generation_run_versions_evaluated
  BEFORE INSERT ON ai.generation_run
  FOR EACH ROW EXECUTE FUNCTION ai.require_evaluated_versions();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT SELECT, INSERT ON ai.evaluation_run TO questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.evaluation_run FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Guarded on what it touches existing: `revertMigrations()` runs every down script against whatever state it finds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = 'generation_run') THEN
    DROP TRIGGER IF EXISTS generation_run_versions_evaluated ON ai.generation_run;
  END IF;
END $$;
DROP FUNCTION IF EXISTS ai.require_evaluated_versions();
DROP TABLE IF EXISTS ai.evaluation_run;
