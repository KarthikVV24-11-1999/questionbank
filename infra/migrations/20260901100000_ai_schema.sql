-- The generation context's physical schema (AI-ARCHITECTURE §11, F28).
-- Patterns applied: P6 UUIDv7 keys, P7 tenant_id.
--
-- `ai` is its own schema, owned by the generation context and migrated
-- independently of the others.
--
-- Fitness and invariants enforced here:
--   F28  every generated artifact records the model version, the prompt
--        version and the run that produced it, as NOT NULL columns. "Prompt v7
--        had a defect — which items are affected?" is one indexed query, and a
--        nullable column could not answer it.
--   F5   every JSONB column has a sibling *_schema_version
--   §9 rule 3: no foreign key crosses a schema boundary. Nothing here
--        references `content.*`; the link from an accepted candidate to the
--        draft it became is an identifier the application carries, never a
--        join. Foreign keys *within* `ai` are fine and are used.
--
-- The pin cannot disagree with its run. A candidate carries the model and
-- prompt version as columns of its own (so the F28 query needs no join), and a
-- composite foreign key to the run makes the database refuse a candidate whose
-- pin differs from the run it names.
--
-- Four tables, all append-only once the paired immutability migration lands.
-- A candidate's lifecycle (proposed → accepted | rejected) is not stored as a
-- mutable `state` column: the proposal is one immutable row, each pre-check
-- verdict is a row, and the decision is a row. A candidate with no decision is
-- proposed. Nothing is ever updated, so "a candidate's recorded verdicts
-- cannot be rewritten after the fact" is a property of the grants and
-- triggers, not of a repository's good behaviour.

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS ai;

-- Time-ordered identifiers (P6), owned by this schema so the contexts can be
-- migrated independently.
CREATE OR REPLACE FUNCTION ai.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes PLACING unix_ts_ms FROM 1 FOR 6);
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$;

-- ───────────────────────────────────────────────────────── generation_run ──

CREATE TABLE ai.generation_run (
  run_id                 uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id              uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  model_version_id       text NOT NULL CHECK (length(btrim(model_version_id)) > 0),
  prompt_version_id      text NOT NULL CHECK (length(btrim(prompt_version_id)) > 0),
  requested_at           timestamptz NOT NULL,
  request                jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  request_schema_version integer NOT NULL DEFAULT 1 CHECK (request_schema_version > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),

  -- The target of generation_candidate's composite foreign key: the pin as the
  -- run recorded it.
  CONSTRAINT generation_run_pin_key UNIQUE (run_id, model_version_id, prompt_version_id)
);

CREATE INDEX generation_run_prompt_version_idx ON ai.generation_run (prompt_version_id);

-- ──────────────────────────────────────────────────── generation_candidate ──

CREATE TABLE ai.generation_candidate (
  candidate_id        uuid PRIMARY KEY DEFAULT ai.uuid_generate_v7(),
  tenant_id           uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- The F28 pin. Not nullable, not a log line.
  run_id              uuid NOT NULL,
  model_version_id    text NOT NULL CHECK (length(btrim(model_version_id)) > 0),
  prompt_version_id   text NOT NULL CHECK (length(btrim(prompt_version_id)) > 0),
  -- The proposal. Held as a document: the shape of `body` is the application
  -- layer's to interpret, and an older proposal must stay readable.
  item_type           text NOT NULL CHECK (length(btrim(item_type)) > 0),
  body                jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_schema_version integer NOT NULL DEFAULT 1 CHECK (body_schema_version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT generation_candidate_pin_matches_run
    FOREIGN KEY (run_id, model_version_id, prompt_version_id)
    REFERENCES ai.generation_run (run_id, model_version_id, prompt_version_id)
);

CREATE INDEX generation_candidate_run_idx ON ai.generation_candidate (run_id, created_at);
-- F28's question, answered without a join.
CREATE INDEX generation_candidate_prompt_version_idx ON ai.generation_candidate (prompt_version_id);

-- ────────────────────────────────────────────────────── candidate_verdict ──

CREATE TABLE ai.candidate_verdict (
  candidate_id uuid NOT NULL REFERENCES ai.generation_candidate (candidate_id),
  -- The closed vocabulary of AI-ARCHITECTURE §11. The list lives in the
  -- domain too (`precheck-vocabulary.ts`); a spec asserts the two agree.
  check_id     text NOT NULL CHECK (check_id IN (
                 'schema_validity', 'renderability', 'answer_verification',
                 'numeric_spec_completeness', 'syllabus_scope',
                 'item_solution_key_consistency', 'distractor_validity',
                 'duplicate_detection', 'difficulty_plausibility', 'ambiguity_clarity',
                 'safety_appropriateness', 'provenance_licensing_completeness')),
  outcome      text NOT NULL CHECK (outcome IN ('pass', 'fail')),
  detail       text,
  -- Position in the order the verdicts were recorded, so a candidate reads
  -- back exactly as it was written.
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  -- One verdict per check: a later pass must never be able to hide an
  -- earlier fail.
  PRIMARY KEY (candidate_id, check_id),
  CONSTRAINT candidate_verdict_ordinal_key UNIQUE (candidate_id, ordinal)
);

-- ───────────────────────────────────────────────────── candidate_decision ──

CREATE TABLE ai.candidate_decision (
  -- At most one decision per candidate, and the decision is the end of its
  -- lifecycle.
  candidate_id uuid PRIMARY KEY REFERENCES ai.generation_candidate (candidate_id),
  decision     text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  decided_at   timestamptz NOT NULL DEFAULT now()
);

-- +migrate Down

DROP TABLE IF EXISTS ai.candidate_decision;
DROP TABLE IF EXISTS ai.candidate_verdict;
DROP TABLE IF EXISTS ai.generation_candidate;
DROP TABLE IF EXISTS ai.generation_run;
DROP FUNCTION IF EXISTS ai.uuid_generate_v7();
DROP SCHEMA IF EXISTS ai;
