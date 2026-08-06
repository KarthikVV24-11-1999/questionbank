-- Curriculum context physical schema (DATA-ARCHITECTURE §4).
-- Patterns applied: P6 UUIDv7 keys, P7 tenant_id, P8 aggregate_version.
-- Fitness: F2 no foreign key crosses a schema boundary; F5 every JSONB column
-- has a sibling *_schema_version.

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS curriculum;

-- Time-ordered identifiers (P6). PostgreSQL gains uuidv7() natively in 18;
-- until then this is the canonical implementation.
CREATE OR REPLACE FUNCTION curriculum.uuid_generate_v7() RETURNS uuid
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

CREATE TABLE curriculum.taxonomy_version (
  taxonomy_version_id  uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  exam_family          text        NOT NULL CHECK (length(btrim(exam_family)) > 0),
  academic_year        text        NOT NULL CHECK (academic_year ~ '^\d{4}(-\d{2})?$'),
  state                text        NOT NULL DEFAULT 'draft'
                                   CHECK (state IN ('draft', 'published', 'superseded')),
  published_at         timestamptz,
  published_by_kind    text        CHECK (published_by_kind IN ('human', 'ai_agent', 'system')),
  published_by_id      uuid,
  aggregate_version    integer     NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_version_publication_stamped
    CHECK ((state = 'draft') = (published_at IS NULL AND published_by_id IS NULL))
);

CREATE INDEX taxonomy_version_tenant_family_year_idx
  ON curriculum.taxonomy_version (tenant_id, exam_family, academic_year);

CREATE TABLE curriculum.concept_identity (
  concept_identity_id uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  canonical_name      text        NOT NULL CHECK (length(btrim(canonical_name)) > 0),
  subject_domain      text        NOT NULL CHECK (length(btrim(subject_domain)) > 0),
  created_in_version  uuid        NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id),
  superseded_by       uuid        REFERENCES curriculum.concept_identity (concept_identity_id),
  aggregate_version   integer     NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concept_identity_not_self_superseding CHECK (superseded_by <> concept_identity_id)
);

CREATE INDEX concept_identity_created_in_version_idx
  ON curriculum.concept_identity (created_in_version);
CREATE INDEX concept_identity_superseded_by_idx
  ON curriculum.concept_identity (superseded_by) WHERE superseded_by IS NOT NULL;

CREATE TABLE curriculum.concept_node (
  concept_node_id          uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  taxonomy_version_id      uuid    NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id) ON DELETE CASCADE,
  concept_identity_id      uuid    NOT NULL REFERENCES curriculum.concept_identity (concept_identity_id),
  parent_node_id           uuid    REFERENCES curriculum.concept_node (concept_node_id),
  display_name             text    NOT NULL CHECK (length(btrim(display_name)) > 0),
  exam_weight              numeric(6, 5) NOT NULL CHECK (exam_weight >= 0 AND exam_weight <= 1),
  depth                    integer NOT NULL CHECK (depth >= 0),
  estimated_teaching_hours numeric(7, 2) NOT NULL CHECK (estimated_teaching_hours >= 0),
  CONSTRAINT concept_node_identity_unique_per_version UNIQUE (taxonomy_version_id, concept_identity_id),
  CONSTRAINT concept_node_not_own_parent CHECK (parent_node_id <> concept_node_id)
);

CREATE INDEX concept_node_parent_idx ON curriculum.concept_node (parent_node_id);
CREATE INDEX concept_node_version_idx ON curriculum.concept_node (taxonomy_version_id);

CREATE TABLE curriculum.prerequisite_edge (
  taxonomy_version_id        uuid NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id) ON DELETE CASCADE,
  from_concept_identity_id   uuid NOT NULL REFERENCES curriculum.concept_identity (concept_identity_id),
  to_concept_identity_id     uuid NOT NULL REFERENCES curriculum.concept_identity (concept_identity_id),
  strength                   numeric(4, 3) NOT NULL CHECK (strength >= 0 AND strength <= 1),
  PRIMARY KEY (taxonomy_version_id, from_concept_identity_id, to_concept_identity_id),
  CONSTRAINT prerequisite_edge_not_self_referencing
    CHECK (from_concept_identity_id <> to_concept_identity_id)
);

CREATE TABLE curriculum.exam (
  exam_id           uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  code              text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,31}$'),
  display_name      text        NOT NULL CHECK (length(btrim(display_name)) > 0),
  jurisdiction      text        NOT NULL,
  conducting_body   text        NOT NULL,
  aggregate_version integer     NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_code_unique_per_tenant UNIQUE (tenant_id, code)
);

CREATE TABLE curriculum.exam_profile_version (
  profile_version_id                   uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id                            uuid    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  exam_id                              uuid    NOT NULL REFERENCES curriculum.exam (exam_id),
  academic_year                        text    NOT NULL CHECK (academic_year ~ '^\d{4}(-\d{2})?$'),
  state                                text    NOT NULL DEFAULT 'draft'
                                               CHECK (state IN ('draft', 'published', 'superseded')),
  taxonomy_version_id                  uuid    NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id),
  total_marks                          numeric(8, 2) NOT NULL CHECK (total_marks > 0),
  timing_policy                        jsonb   NOT NULL,
  timing_policy_schema_version         integer NOT NULL DEFAULT 1,
  navigation_policy                    jsonb   NOT NULL,
  navigation_policy_schema_version     integer NOT NULL DEFAULT 1,
  marking_rule_set                     jsonb   NOT NULL,
  marking_rule_set_schema_version      integer NOT NULL DEFAULT 1,
  marking_rule_set_hash                text,
  tolerance_defaults                   jsonb,
  tolerance_defaults_schema_version    integer NOT NULL DEFAULT 1,
  item_type_allowances                 jsonb   NOT NULL,
  item_type_allowances_schema_version  integer NOT NULL DEFAULT 1,
  golden_set_validation                jsonb   NOT NULL DEFAULT '{"status":"not_run"}'::jsonb,
  golden_set_validation_schema_version integer NOT NULL DEFAULT 1,
  is_active                            boolean NOT NULL DEFAULT false,
  published_at                         timestamptz,
  published_by_kind                    text    CHECK (published_by_kind IN ('human', 'ai_agent', 'system')),
  published_by_id                      uuid,
  aggregate_version                    integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_profile_version_publication_stamped
    CHECK ((state = 'draft') = (published_at IS NULL AND published_by_id IS NULL)),
  CONSTRAINT exam_profile_version_hash_frozen_at_publication
    CHECK ((state = 'draft') = (marking_rule_set_hash IS NULL)),
  CONSTRAINT exam_profile_version_only_published_is_active
    CHECK (NOT is_active OR state = 'published')
);

-- At most one active profile version per exam and academic year.
CREATE UNIQUE INDEX exam_profile_version_one_active_per_year_idx
  ON curriculum.exam_profile_version (exam_id, academic_year) WHERE is_active;
CREATE INDEX exam_profile_version_exam_idx ON curriculum.exam_profile_version (exam_id);
CREATE INDEX exam_profile_version_taxonomy_idx ON curriculum.exam_profile_version (taxonomy_version_id);

CREATE TABLE curriculum.exam_section_spec (
  section_spec_id              uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  profile_version_id           uuid    NOT NULL REFERENCES curriculum.exam_profile_version (profile_version_id) ON DELETE CASCADE,
  ordinal                      integer NOT NULL CHECK (ordinal >= 1),
  name                         text    NOT NULL CHECK (length(btrim(name)) > 0),
  subject                      text    NOT NULL CHECK (length(btrim(subject)) > 0),
  item_count                   integer NOT NULL CHECK (item_count >= 1),
  item_type_mix                jsonb   NOT NULL,
  item_type_mix_schema_version integer NOT NULL DEFAULT 1,
  max_marks                    numeric(8, 2) NOT NULL CHECK (max_marks > 0),
  section_timing_minutes       integer CHECK (section_timing_minutes > 0),
  CONSTRAINT exam_section_spec_ordinal_unique_per_profile UNIQUE (profile_version_id, ordinal)
);

CREATE TABLE curriculum.taxonomy_migration (
  migration_id                  uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id                     uuid    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  from_version                  uuid    NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id),
  to_version                    uuid    NOT NULL REFERENCES curriculum.taxonomy_version (taxonomy_version_id),
  state                         text    NOT NULL DEFAULT 'draft'
                                        CHECK (state IN ('draft', 'executing', 'executed')),
  dry_run_result                jsonb,
  dry_run_result_schema_version integer NOT NULL DEFAULT 1,
  aggregate_version             integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_migration_between_two_versions CHECK (from_version <> to_version)
);

CREATE INDEX taxonomy_migration_from_idx ON curriculum.taxonomy_migration (from_version);
CREATE INDEX taxonomy_migration_to_idx ON curriculum.taxonomy_migration (to_version);

CREATE TABLE curriculum.taxonomy_mapping (
  mapping_id   uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  migration_id uuid    NOT NULL REFERENCES curriculum.taxonomy_migration (migration_id) ON DELETE CASCADE,
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  kind         text    NOT NULL
                       CHECK (kind IN ('identity', 'rename', 'move', 'split', 'merge', 'removal')),
  from_ids     uuid[]  NOT NULL,
  to_ids       uuid[]  NOT NULL,
  disposition  text    NOT NULL DEFAULT 'pending'
                       CHECK (disposition IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT taxonomy_mapping_ordinal_unique_per_migration UNIQUE (migration_id, ordinal),
  CONSTRAINT taxonomy_mapping_cardinality CHECK (
    CASE kind
      WHEN 'split'   THEN cardinality(from_ids) = 1 AND cardinality(to_ids) >= 2
      WHEN 'merge'   THEN cardinality(from_ids) >= 2 AND cardinality(to_ids) = 1
      WHEN 'removal' THEN cardinality(from_ids) = 1 AND cardinality(to_ids) = 0
      ELSE cardinality(from_ids) = 1 AND cardinality(to_ids) = 1
    END
  )
);

CREATE INDEX taxonomy_mapping_migration_idx ON curriculum.taxonomy_mapping (migration_id);

-- +migrate Down

DROP TABLE IF EXISTS curriculum.taxonomy_mapping;
DROP TABLE IF EXISTS curriculum.taxonomy_migration;
DROP TABLE IF EXISTS curriculum.exam_section_spec;
DROP TABLE IF EXISTS curriculum.exam_profile_version;
DROP TABLE IF EXISTS curriculum.exam;
DROP TABLE IF EXISTS curriculum.prerequisite_edge;
DROP TABLE IF EXISTS curriculum.concept_node;
DROP TABLE IF EXISTS curriculum.concept_identity;
DROP TABLE IF EXISTS curriculum.taxonomy_version;
DROP FUNCTION IF EXISTS curriculum.uuid_generate_v7();
DROP SCHEMA IF EXISTS curriculum;
