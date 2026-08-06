-- Publication immutability enforced at the database, not in application code
-- (INV-03, DATA-ARCHITECTURE P5). Triggers are not role-aware, so a direct
-- psql UPDATE is rejected exactly as an ORM UPDATE is.
--
-- Row triggers do not fire on TRUNCATE; that path is closed by withholding the
-- grant from the application role (P5), not here.

-- +migrate Up

-- A published version may change in exactly one way: becoming superseded.
CREATE OR REPLACE FUNCTION curriculum.reject_published_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'published_row_is_immutable: a % row cannot be deleted while %',
        TG_TABLE_NAME, OLD.state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Content is frozen. Only three things may still move on a published row:
  -- the activation flag, the concurrency counter, and the single legal
  -- transition to superseded.
  IF to_jsonb(NEW) - 'state' - 'is_active' - 'aggregate_version'
     = to_jsonb(OLD) - 'state' - 'is_active' - 'aggregate_version'
     AND (NEW.state = OLD.state OR (OLD.state = 'published' AND NEW.state = 'superseded')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'published_row_is_immutable: % is % and rejects this update', TG_TABLE_NAME, OLD.state
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER taxonomy_version_published_immutable
  BEFORE UPDATE OR DELETE ON curriculum.taxonomy_version
  FOR EACH ROW EXECUTE FUNCTION curriculum.reject_published_mutation();

CREATE TRIGGER exam_profile_version_published_immutable
  BEFORE UPDATE OR DELETE ON curriculum.exam_profile_version
  FOR EACH ROW EXECUTE FUNCTION curriculum.reject_published_mutation();

-- Children of a published parent are equally frozen. The parent's state is the
-- authority; the child carries none of its own. A cascade from a deleted draft
-- parent finds no parent row and is allowed through.
CREATE OR REPLACE FUNCTION curriculum.reject_mutation_under_published_taxonomy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id uuid;
  parent_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.taxonomy_version_id;
  ELSE
    parent_id := NEW.taxonomy_version_id;
  END IF;

  SELECT state INTO parent_state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = parent_id;

  IF parent_state IS NOT NULL AND parent_state <> 'draft' THEN
    RAISE EXCEPTION 'published_parent_is_immutable: % cannot change while its taxonomy version is %',
      TG_TABLE_NAME, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION curriculum.reject_mutation_under_published_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id uuid;
  parent_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.profile_version_id;
  ELSE
    parent_id := NEW.profile_version_id;
  END IF;

  SELECT state INTO parent_state FROM curriculum.exam_profile_version WHERE profile_version_id = parent_id;

  IF parent_state IS NOT NULL AND parent_state <> 'draft' THEN
    RAISE EXCEPTION 'published_parent_is_immutable: % cannot change while its profile version is %',
      TG_TABLE_NAME, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER concept_node_parent_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON curriculum.concept_node
  FOR EACH ROW EXECUTE FUNCTION curriculum.reject_mutation_under_published_taxonomy();

CREATE TRIGGER prerequisite_edge_parent_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON curriculum.prerequisite_edge
  FOR EACH ROW EXECUTE FUNCTION curriculum.reject_mutation_under_published_taxonomy();

CREATE TRIGGER exam_section_spec_parent_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON curriculum.exam_section_spec
  FOR EACH ROW EXECUTE FUNCTION curriculum.reject_mutation_under_published_profile();

-- +migrate Down

DROP TRIGGER IF EXISTS exam_section_spec_parent_published_immutable ON curriculum.exam_section_spec;
DROP TRIGGER IF EXISTS prerequisite_edge_parent_published_immutable ON curriculum.prerequisite_edge;
DROP TRIGGER IF EXISTS concept_node_parent_published_immutable ON curriculum.concept_node;
DROP TRIGGER IF EXISTS exam_profile_version_published_immutable ON curriculum.exam_profile_version;
DROP TRIGGER IF EXISTS taxonomy_version_published_immutable ON curriculum.taxonomy_version;
DROP FUNCTION IF EXISTS curriculum.reject_mutation_under_published_profile();
DROP FUNCTION IF EXISTS curriculum.reject_mutation_under_published_taxonomy();
DROP FUNCTION IF EXISTS curriculum.reject_published_mutation();
