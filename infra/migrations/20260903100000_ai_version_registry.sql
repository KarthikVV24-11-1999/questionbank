-- The model and prompt version registry (M5-21, AI-ARCHITECTURE §15).
--
-- Versions are rows, pinned by reference. §15 publishes prompts to the database
-- as immutable versions "at deploy" because rows give referential integrity with
-- item provenance: "prompt v7 had a defect — which items are affected?" is a
-- join, not a string match, and two runs cannot name one version in two
-- spellings. Content already stores the same three ids as `uuid`, so a pin that
-- is a registry row is also one content can store.
--
--   model_version   which model it pins, and that automatic upgrades are
--                   prohibited — a model that changes underneath a recorded
--                   pin would re-label every artifact it produced.
--   prompt_version  the file it was published from and that file's digest, so a
--                   row traces back to a diff.
--
-- Then `generation_run`'s pin becomes `uuid` with foreign keys into the two
-- registries. Within `ai` foreign keys are expected and wanted; §9 rule 3 only
-- forbids crossing a schema.
--
-- WHY THE COLUMN TYPE CHANGE IS SAFE. `model_version_id` and `prompt_version_id`
-- were `text` on `generation_run` and `generation_candidate`, and nothing in a
-- deployed system has written either: the `ai` tables had no writer before the
-- handlers of M5 Track C, and none has run against a deployed database. The
-- guard below asserts that instead of assuming it — it refuses to run over any
-- existing run, because a run could name a label that is not a UUID, or a UUID
-- with no registry row, and either would make the conversion lose or invent a
-- meaning. Better a loud stop than a silent cast.

-- +migrate Up

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.generation_run) THEN
    RAISE EXCEPTION 'ai_version_registry_refuses_existing_runs: % run(s) already name text version ids; register their versions and backfill before converting the pin to uuid',
      (SELECT count(*) FROM ai.generation_run);
  END IF;
END $$;

CREATE TABLE ai.model_version (
  model_version_id            uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id                   uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- The model this row pins, exactly as the provider names it.
  provider_model_id           text NOT NULL CHECK (length(btrim(provider_model_id)) > 0),
  -- §15: a recorded pin is never silently upgraded. Stored as a fact and
  -- constrained true, so a row claiming otherwise cannot be written.
  automatic_upgrades_prohibited boolean NOT NULL CHECK (automatic_upgrades_prohibited),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  -- One row per pinned model: two spellings of one version are what the
  -- registry exists to prevent.
  CONSTRAINT model_version_provider_model_key UNIQUE (provider_model_id)
);

CREATE TABLE ai.prompt_version (
  prompt_version_id uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- The file this version was published from, and its digest: the row traces
  -- back to a diff, and republishing an unchanged file is the same version.
  source_file       text NOT NULL CHECK (length(btrim(source_file)) > 0),
  content_sha256    text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_version_source_key UNIQUE (source_file, content_sha256)
);

-- The composite key and the text-only checks go first: a foreign key cannot
-- survive its two sides changing type one at a time, and `btrim` has no uuid form.
ALTER TABLE ai.generation_candidate DROP CONSTRAINT generation_candidate_pin_matches_run;
ALTER TABLE ai.generation_run DROP CONSTRAINT generation_run_model_version_id_check;
ALTER TABLE ai.generation_run DROP CONSTRAINT generation_run_prompt_version_id_check;
ALTER TABLE ai.generation_candidate DROP CONSTRAINT generation_candidate_model_version_id_check;
ALTER TABLE ai.generation_candidate DROP CONSTRAINT generation_candidate_prompt_version_id_check;

ALTER TABLE ai.generation_run
  ALTER COLUMN model_version_id TYPE uuid USING model_version_id::uuid,
  ALTER COLUMN prompt_version_id TYPE uuid USING prompt_version_id::uuid;
ALTER TABLE ai.generation_candidate
  ALTER COLUMN model_version_id TYPE uuid USING model_version_id::uuid,
  ALTER COLUMN prompt_version_id TYPE uuid USING prompt_version_id::uuid;

ALTER TABLE ai.generation_run
  ADD CONSTRAINT generation_run_model_version_fk
    FOREIGN KEY (model_version_id) REFERENCES ai.model_version (model_version_id),
  ADD CONSTRAINT generation_run_prompt_version_fk
    FOREIGN KEY (prompt_version_id) REFERENCES ai.prompt_version (prompt_version_id);

-- The candidate's pin still cannot disagree with its run's.
ALTER TABLE ai.generation_candidate
  ADD CONSTRAINT generation_candidate_pin_matches_run
    FOREIGN KEY (run_id, model_version_id, prompt_version_id)
    REFERENCES ai.generation_run (run_id, model_version_id, prompt_version_id);

-- +migrate Down

-- Safe against a schema-less database: everything is guarded on the registry
-- existing, since `revertMigrations()` runs every down script against whatever
-- state it finds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ai' AND table_name = 'model_version') THEN
    ALTER TABLE ai.generation_candidate DROP CONSTRAINT IF EXISTS generation_candidate_pin_matches_run;
    ALTER TABLE ai.generation_run DROP CONSTRAINT IF EXISTS generation_run_model_version_fk;
    ALTER TABLE ai.generation_run DROP CONSTRAINT IF EXISTS generation_run_prompt_version_fk;

    ALTER TABLE ai.generation_run
      ALTER COLUMN model_version_id TYPE text USING model_version_id::text,
      ALTER COLUMN prompt_version_id TYPE text USING prompt_version_id::text;
    ALTER TABLE ai.generation_candidate
      ALTER COLUMN model_version_id TYPE text USING model_version_id::text,
      ALTER COLUMN prompt_version_id TYPE text USING prompt_version_id::text;

    ALTER TABLE ai.generation_run
      ADD CONSTRAINT generation_run_model_version_id_check CHECK (length(btrim(model_version_id)) > 0),
      ADD CONSTRAINT generation_run_prompt_version_id_check CHECK (length(btrim(prompt_version_id)) > 0);
    ALTER TABLE ai.generation_candidate
      ADD CONSTRAINT generation_candidate_model_version_id_check CHECK (length(btrim(model_version_id)) > 0),
      ADD CONSTRAINT generation_candidate_prompt_version_id_check CHECK (length(btrim(prompt_version_id)) > 0),
      ADD CONSTRAINT generation_candidate_pin_matches_run
        FOREIGN KEY (run_id, model_version_id, prompt_version_id)
        REFERENCES ai.generation_run (run_id, model_version_id, prompt_version_id);
  END IF;
END $$;

DROP TABLE IF EXISTS ai.prompt_version;
DROP TABLE IF EXISTS ai.model_version;
