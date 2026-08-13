-- Content context physical schema (DOMAIN-MODEL §5, DATA-ARCHITECTURE §4).
-- Patterns applied: P1 identity/version split, P2 lifecycle state not soft
-- delete, P6 UUIDv7 keys, P7 tenant_id, P8 aggregate_version.
--
-- Fitness and invariants enforced here:
--   F5   every JSONB column has a sibling *_schema_version
--   ACC-03 media_asset_version.alt_text NOT NULL with a non-blank check, so an
--          asset without alt text cannot be stored even if some future code
--          path forgets — the type refuses it too (M3-15), and neither check
--          is sufficient alone
--   INV-03 at most one published version per aggregate, as a partial unique
--          index rather than a rule somebody remembers
--   §9 rule 3: no foreign key crosses a schema boundary. concept_identity_id
--          and taxonomy_version_id are carried as values — Content conforms to
--          Curriculum's contract, it does not join to its tables
--
-- `content_media_ref` normalizes the media usage graph so "which published
-- content uses this asset?" is a join rather than a JSON scan. Without it,
-- refusing deletion of an in-use asset (FR-QM-06 rule 3) is unenforceable at
-- any size.

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS content;

-- Time-ordered identifiers (P6), owned by this schema so the contexts can be
-- migrated independently.
CREATE OR REPLACE FUNCTION content.uuid_generate_v7() RETURNS uuid
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

-- The eight lifecycle states of FR-QM-01, as one domain reused by every
-- content aggregate. A second spelling of the same list is a second thing to
-- keep in step.
CREATE DOMAIN content.lifecycle_state AS text
  CHECK (VALUE IN ('draft', 'in_review', 'changes_requested', 'approved',
                   'rejected', 'published', 'suspended', 'retired'));

-- ─────────────────────────────────────────────────────────── stimulus ──
-- Declared before item, because item_version references a stimulus version.

CREATE TABLE content.stimulus (
  stimulus_id                  uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id                    uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  stimulus_type                text NOT NULL
                                 CHECK (stimulus_type IN ('passage', 'diagram', 'dataset', 'reaction_scheme')),
  lifecycle_state              content.lifecycle_state NOT NULL DEFAULT 'draft',
  current_published_version_id uuid,
  retirement_reason            text,
  aggregate_version            integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stimulus_published_names_a_version
    CHECK (lifecycle_state NOT IN ('published', 'suspended') OR current_published_version_id IS NOT NULL),
  CONSTRAINT stimulus_retired_has_reason
    CHECK (lifecycle_state <> 'retired' OR length(btrim(coalesce(retirement_reason, ''))) > 0)
);

CREATE TABLE content.stimulus_version (
  stimulus_version_id       uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  stimulus_id               uuid NOT NULL REFERENCES content.stimulus (stimulus_id) ON DELETE CASCADE,
  version_no                integer NOT NULL CHECK (version_no > 0),
  body                      jsonb NOT NULL,
  body_schema_version       integer NOT NULL DEFAULT 1,
  body_plain_text           text NOT NULL,
  notation_terms            text[] NOT NULL DEFAULT '{}',
  authored_by_kind          text NOT NULL CHECK (authored_by_kind IN ('human', 'ai_agent', 'system')),
  authored_by_id            uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- When the draft was last autosaved; stops moving once the version publishes.
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stimulus_version_no_unique UNIQUE (stimulus_id, version_no)
);

CREATE INDEX stimulus_version_stimulus_idx ON content.stimulus_version (stimulus_id);

ALTER TABLE content.stimulus
  ADD CONSTRAINT stimulus_published_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES content.stimulus_version (stimulus_version_id);

-- ───────────────────────────────────────────────────────────── item ──

CREATE TABLE content.item (
  item_id                      uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id                    uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- Closed and mirrored from scoring's vocabulary (DEC-3). Adding one is a
  -- reviewed change in both places; the seam spec fails until it is.
  item_type                    text NOT NULL
                                 CHECK (item_type IN ('SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ',
                                                      'MATCHING', 'NUMERIC')),
  lifecycle_state              content.lifecycle_state NOT NULL DEFAULT 'draft',
  current_published_version_id uuid,
  retirement_reason            text,
  replaced_by_item_id          uuid REFERENCES content.item (item_id),
  -- P2: a draft may be discarded; nothing past draft may (FR-QM-01 rule 5).
  deleted_at                   timestamptz,
  aggregate_version            integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_published_names_a_version
    CHECK (lifecycle_state NOT IN ('published', 'suspended') OR current_published_version_id IS NOT NULL),
  CONSTRAINT item_retired_has_reason
    CHECK (lifecycle_state <> 'retired' OR length(btrim(coalesce(retirement_reason, ''))) > 0),
  CONSTRAINT item_not_replaced_by_itself
    CHECK (replaced_by_item_id IS NULL OR replaced_by_item_id <> item_id),
  -- Only a draft is ever discarded, and only one that never published.
  CONSTRAINT item_only_drafts_are_deleted
    CHECK (deleted_at IS NULL OR (lifecycle_state = 'draft' AND current_published_version_id IS NULL))
);

CREATE INDEX item_tenant_state_idx ON content.item (tenant_id, lifecycle_state) WHERE deleted_at IS NULL;

CREATE TABLE content.item_version (
  item_version_id       uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  item_id               uuid NOT NULL REFERENCES content.item (item_id) ON DELETE CASCADE,
  version_no            integer NOT NULL CHECK (version_no > 0),
  item_type             text NOT NULL
                          CHECK (item_type IN ('SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ',
                                               'MATCHING', 'NUMERIC')),
  stem_body             jsonb NOT NULL,
  stem_body_schema_version integer NOT NULL DEFAULT 1,
  -- Derived projections, written in the same statement as the document
  -- (DATA-ARCHITECTURE §2). A projection written later is a projection that
  -- can disagree with what it summarizes.
  stem_plain_text       text NOT NULL,
  notation_terms        text[] NOT NULL DEFAULT '{}',
  difficulty_estimate   text NOT NULL
                          CHECK (difficulty_estimate IN ('foundational', 'moderate', 'challenging', 'advanced')),
  -- Pins a stimulus *version*, so an edit elsewhere cannot change what this
  -- item asked (FR-TCH-03 rule 2).
  stimulus_version_id   uuid REFERENCES content.stimulus_version (stimulus_version_id),
  authored_by_kind      text NOT NULL CHECK (authored_by_kind IN ('human', 'ai_agent', 'system')),
  authored_by_id        uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- When the draft was last autosaved. Not on the domain type: an ItemVersion
  -- is an immutable snapshot with one authored instant, and the moment the
  -- version publishes this column stops moving with it. It exists because "the
  -- drafts I was working on" is the ordering the item browser needs, and
  -- because a projection that can only be derived from an audit log is a
  -- projection no query can use.
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_version_no_unique UNIQUE (item_id, version_no)
);

CREATE INDEX item_version_item_idx ON content.item_version (item_id);
CREATE INDEX item_version_stimulus_idx ON content.item_version (stimulus_version_id)
  WHERE stimulus_version_id IS NOT NULL;

ALTER TABLE content.item
  ADD CONSTRAINT item_published_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES content.item_version (item_version_id);

CREATE TABLE content.item_option (
  item_version_id  uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  option_id        text NOT NULL CHECK (length(btrim(option_id)) > 0),
  ordinal          integer NOT NULL CHECK (ordinal > 0),
  body             jsonb NOT NULL,
  body_schema_version integer NOT NULL DEFAULT 1,
  body_plain_text  text NOT NULL,
  -- The key half. Never selected into a delivery payload (ADR-0009); the
  -- authoring queries are the only readers.
  is_correct       boolean NOT NULL DEFAULT false,

  PRIMARY KEY (item_version_id, option_id),
  CONSTRAINT item_option_ordinal_unique UNIQUE (item_version_id, ordinal)
);

CREATE TABLE content.item_matching_member (
  item_version_id  uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  side             text NOT NULL CHECK (side IN ('left', 'right')),
  member_id        text NOT NULL CHECK (length(btrim(member_id)) > 0),
  ordinal          integer NOT NULL CHECK (ordinal > 0),
  body             jsonb NOT NULL,
  body_schema_version integer NOT NULL DEFAULT 1,
  body_plain_text  text NOT NULL,

  PRIMARY KEY (item_version_id, side, member_id),
  CONSTRAINT item_matching_member_ordinal_unique UNIQUE (item_version_id, side, ordinal)
);

CREATE TABLE content.item_matching_pair (
  item_version_id  uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  left_member_id   text NOT NULL,
  right_member_id  text NOT NULL,
  -- Constants, so the composite foreign keys below can name the side. A
  -- literal is not permitted in a foreign-key column list, and the
  -- alternative — no reference at all — would let a pair name a member the
  -- item does not define, which is the one thing that makes a matching key
  -- unscoreable.
  left_side        text NOT NULL DEFAULT 'left'  CHECK (left_side = 'left'),
  right_side       text NOT NULL DEFAULT 'right' CHECK (right_side = 'right'),

  -- One right member may answer several left members; a left member may not
  -- be matched twice (M3-07).
  PRIMARY KEY (item_version_id, left_member_id),
  -- Named explicitly: Postgres truncates a generated composite-key name at 63
  -- characters, and a constraint nobody can name is a constraint no test can
  -- assert on.
  CONSTRAINT item_matching_pair_left_member_fk
    FOREIGN KEY (item_version_id, left_side, left_member_id)
    REFERENCES content.item_matching_member (item_version_id, side, member_id) ON DELETE CASCADE,
  CONSTRAINT item_matching_pair_right_member_fk
    FOREIGN KEY (item_version_id, right_side, right_member_id)
    REFERENCES content.item_matching_member (item_version_id, side, member_id) ON DELETE CASCADE
);

CREATE TABLE content.item_numeric_spec (
  item_version_id      uuid PRIMARY KEY REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  -- The authored decimal literal, as text. Storing it numeric would discard
  -- trailing zeros that SIGNIFICANT_FIGURES counts, and ADR-0007 rests on the
  -- literal surviving unchanged from author to executor.
  expected_value       text NOT NULL CHECK (length(btrim(expected_value)) > 0),
  comparison_mode      text NOT NULL
                         CHECK (comparison_mode IN ('EXACT', 'ABSOLUTE_TOLERANCE', 'RELATIVE_TOLERANCE',
                                                    'SIGNIFICANT_FIGURES', 'RANGE')),
  tolerance_value      text,
  significant_figures  integer CHECK (significant_figures IS NULL OR significant_figures >= 1),
  range_min            text,
  range_max            text,
  unit_canonical       text,
  unit_accepted_equivalents text[] NOT NULL DEFAULT '{}',
  unit_required        boolean NOT NULL DEFAULT false,
  accepted_forms       text[] NOT NULL CHECK (array_length(accepted_forms, 1) >= 1),

  -- D-001 rule 5 at the database: a mode missing its parameter is invalid, so
  -- it cannot be stored and then fail at scoring time.
  CONSTRAINT item_numeric_spec_mode_parameters CHECK (
    CASE comparison_mode
      WHEN 'ABSOLUTE_TOLERANCE' THEN tolerance_value IS NOT NULL
      WHEN 'RELATIVE_TOLERANCE' THEN tolerance_value IS NOT NULL
      WHEN 'SIGNIFICANT_FIGURES' THEN significant_figures IS NOT NULL
      WHEN 'RANGE' THEN range_min IS NOT NULL AND range_max IS NOT NULL
      ELSE true
    END
  ),
  CONSTRAINT item_numeric_spec_unit_named
    CHECK (NOT unit_required OR length(btrim(coalesce(unit_canonical, ''))) > 0)
);

CREATE TABLE content.item_taxonomy_tag (
  item_version_id      uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  -- Values, not references: §9 rule 3 forbids a foreign key into curriculum,
  -- and a tag is meaningful under the taxonomy version it names even after
  -- that version is superseded.
  concept_identity_id  uuid NOT NULL,
  taxonomy_version_id  uuid NOT NULL,
  weight               numeric(4, 3) NOT NULL CHECK (weight >= 0 AND weight <= 1),
  is_primary           boolean NOT NULL DEFAULT false,

  PRIMARY KEY (item_version_id, concept_identity_id)
);

-- Exactly one primary tag per version (M3-04), as an index rather than a rule.
CREATE UNIQUE INDEX item_taxonomy_tag_one_primary
  ON content.item_taxonomy_tag (item_version_id) WHERE is_primary;

CREATE INDEX item_taxonomy_tag_concept_idx
  ON content.item_taxonomy_tag (concept_identity_id, taxonomy_version_id);

CREATE TABLE content.item_provenance (
  item_version_id    uuid PRIMARY KEY REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  source_type        text NOT NULL
                       CHECK (source_type IN ('original', 'previous_year', 'licensed',
                                              'ai_generated', 'ai_assisted')),
  source_exam        text,
  source_year        integer,
  source_session     text,
  author_ref         text,
  model_version_id   uuid,
  prompt_version_id  uuid,
  generation_run_id  uuid,
  confidence         numeric(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  import_batch_id    uuid,

  CONSTRAINT item_provenance_previous_year_identified
    CHECK (source_type <> 'previous_year' OR (source_exam IS NOT NULL AND source_year IS NOT NULL)),
  CONSTRAINT item_provenance_licensed_attributed
    CHECK (source_type <> 'licensed' OR length(btrim(coalesce(author_ref, ''))) > 0),
  -- Half of what makes INV-01 auditable: an AI item nobody can trace back to a
  -- model, prompt and run cannot be recalled when that model turns out wrong.
  CONSTRAINT item_provenance_ai_attributed CHECK (
    source_type NOT IN ('ai_generated', 'ai_assisted')
    OR (model_version_id IS NOT NULL AND prompt_version_id IS NOT NULL
        AND generation_run_id IS NOT NULL AND confidence IS NOT NULL)
  ),
  -- And the reverse: model fields on a human source are mislabelled AI content
  -- or a copy-paste, both of which defeat the same audit.
  CONSTRAINT item_provenance_no_ai_fields_on_human_source CHECK (
    source_type IN ('ai_generated', 'ai_assisted')
    OR (model_version_id IS NULL AND prompt_version_id IS NULL
        AND generation_run_id IS NULL AND confidence IS NULL)
  )
);

-- Licensing, per DATA-ARCHITECTURE §4's `content_licensing`: one row per
-- content version, whatever kind. The owner is polymorphic and therefore
-- carries no foreign key — the same trade `content_media_ref` makes, and the
-- reason the document models it as its own table rather than four sets of
-- columns.
CREATE TABLE content.content_licensing (
  -- Item, stimulus and media carry rights; a solution is our own explanation
  -- of somebody else's question and has no licence of its own, so it is absent
  -- from this vocabulary rather than allowed and never used.
  owner_type       text NOT NULL
                     CHECK (owner_type IN ('item_version', 'stimulus_version', 'media_asset_version')),
  owner_version_id uuid NOT NULL,
  status           text NOT NULL CHECK (status IN ('owned', 'licensed', 'public_domain', 'unresolved')),
  license_ref      text,
  attribution      text,
  expires_at       timestamptz,

  PRIMARY KEY (owner_type, owner_version_id),
  -- FR-QM-05: a licence nobody can identify or attribute is not a licence.
  CONSTRAINT content_licensing_licensed_is_identified
    CHECK (status <> 'licensed'
           OR (length(btrim(coalesce(license_ref, ''))) > 0
               AND length(btrim(coalesce(attribution, ''))) > 0)),
  -- Only a licence runs out. An expiry elsewhere is a licence mislabelled as
  -- ownership, and ignoring it would hide exactly that.
  CONSTRAINT content_licensing_only_licences_expire
    CHECK (expires_at IS NULL OR status = 'licensed')
);

CREATE INDEX content_licensing_owner_idx ON content.content_licensing (owner_version_id);

-- ────────────────────────────────────────────────────────── solution ──

CREATE TABLE content.solution (
  solution_id                  uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id                    uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  item_id                      uuid NOT NULL REFERENCES content.item (item_id) ON DELETE CASCADE,
  -- Targets a version, so correcting an explanation invalidates no attempt
  -- (D5, FR-TCH-04 rule 3).
  target_item_version_id       uuid NOT NULL REFERENCES content.item_version (item_version_id),
  lifecycle_state              content.lifecycle_state NOT NULL DEFAULT 'draft',
  current_published_version_id uuid,
  aggregate_version            integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT solution_published_names_a_version
    CHECK (lifecycle_state NOT IN ('published', 'suspended') OR current_published_version_id IS NOT NULL)
);

CREATE INDEX solution_item_idx ON content.solution (item_id);
CREATE INDEX solution_target_version_idx ON content.solution (target_item_version_id);

CREATE TABLE content.solution_version (
  solution_version_id      uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  solution_id              uuid NOT NULL REFERENCES content.solution (solution_id) ON DELETE CASCADE,
  version_no               integer NOT NULL CHECK (version_no > 0),
  final_answer_kind        text NOT NULL CHECK (final_answer_kind IN ('OPTION', 'OPTION_SET', 'PAIRS', 'NUMERIC')),
  final_answer             jsonb NOT NULL,
  final_answer_schema_version integer NOT NULL DEFAULT 1,
  authored_by_kind         text NOT NULL CHECK (authored_by_kind IN ('human', 'ai_agent', 'system')),
  authored_by_id           uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- When the draft was last autosaved; stops moving once the version publishes.
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT solution_version_no_unique UNIQUE (solution_id, version_no)
);

CREATE INDEX solution_version_solution_idx ON content.solution_version (solution_id);

ALTER TABLE content.solution
  ADD CONSTRAINT solution_published_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES content.solution_version (solution_version_id);

CREATE TABLE content.solution_step (
  solution_version_id uuid NOT NULL REFERENCES content.solution_version (solution_version_id) ON DELETE CASCADE,
  ordinal             integer NOT NULL CHECK (ordinal > 0),
  body                jsonb NOT NULL,
  body_schema_version integer NOT NULL DEFAULT 1,
  body_plain_text     text NOT NULL,
  concept_refs        uuid[] NOT NULL DEFAULT '{}',

  PRIMARY KEY (solution_version_id, ordinal)
);

CREATE TABLE content.distractor_analysis (
  solution_version_id            uuid NOT NULL REFERENCES content.solution_version (solution_version_id) ON DELETE CASCADE,
  option_id                      text NOT NULL CHECK (length(btrim(option_id)) > 0),
  misconception_body             jsonb NOT NULL,
  misconception_body_schema_version integer NOT NULL DEFAULT 1,
  misconception_plain_text       text NOT NULL,

  PRIMARY KEY (solution_version_id, option_id)
);

CREATE TABLE content.alternate_approach (
  solution_version_id  uuid NOT NULL REFERENCES content.solution_version (solution_version_id) ON DELETE CASCADE,
  label                text NOT NULL CHECK (length(btrim(label)) > 0),
  steps                jsonb NOT NULL,
  steps_schema_version integer NOT NULL DEFAULT 1,
  applicability_note   text,

  PRIMARY KEY (solution_version_id, label)
);

-- ───────────────────────────────────────────────────────── media ──

CREATE TABLE content.media_asset (
  asset_id                     uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id                    uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  asset_type                   text NOT NULL
                                 CHECK (asset_type IN ('photograph', 'diagram', 'chart', 'graph', 'reaction_scheme')),
  lifecycle_state              content.lifecycle_state NOT NULL DEFAULT 'draft',
  current_published_version_id uuid,
  retirement_reason            text,
  aggregate_version            integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT media_asset_published_names_a_version
    CHECK (lifecycle_state NOT IN ('published', 'suspended') OR current_published_version_id IS NOT NULL)
);

CREATE TABLE content.media_asset_version (
  asset_version_id  uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  asset_id          uuid NOT NULL REFERENCES content.media_asset (asset_id) ON DELETE CASCADE,
  version_no        integer NOT NULL CHECK (version_no > 0),
  -- Bytes live in object storage, never here (DEC-6, TECH-STACK §3).
  storage_key       text NOT NULL CHECK (length(btrim(storage_key)) > 0),
  checksum          text NOT NULL CHECK (length(btrim(checksum)) > 0),
  mime_type         text NOT NULL
                      CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  width             integer NOT NULL CHECK (width > 0),
  height            integer NOT NULL CHECK (height > 0),
  -- ACC-03 at the database as well as in the type. Neither check is
  -- sufficient alone: the type stops the code path, this stops everything else.
  alt_text          text NOT NULL CHECK (length(btrim(alt_text)) > 0),
  long_description  text,
  authored_by_kind  text NOT NULL CHECK (authored_by_kind IN ('human', 'ai_agent', 'system')),
  authored_by_id    uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT media_asset_version_no_unique UNIQUE (asset_id, version_no)
);

CREATE INDEX media_asset_version_asset_idx ON content.media_asset_version (asset_id);

ALTER TABLE content.media_asset
  ADD CONSTRAINT media_asset_published_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES content.media_asset_version (asset_version_id);

-- The review record (FR-QM-03, INV-07). M4 owns the *workspace* that produces
-- decisions — assignment, ageing, the reviewer's screen — but the record itself
-- lands here, because a publication precondition that depends on another
-- milestone's storage is not a precondition.
--
-- Append-only in intent: a reviewer who changes their mind records a second
-- decision, so the history FR-TCH-09 rule 1 needs survives. The owner is
-- polymorphic and therefore carries no foreign key, the same trade
-- `content_licensing` and `content_media_ref` make.
CREATE TABLE content.review_decision (
  review_decision_id uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  owner_type         text NOT NULL
                       CHECK (owner_type IN ('item_version', 'stimulus_version',
                                             'solution_version', 'media_asset_version')),
  owner_version_id   uuid NOT NULL,
  reviewer_kind      text NOT NULL CHECK (reviewer_kind IN ('human', 'ai_agent', 'system')),
  reviewer_id        uuid NOT NULL,
  outcome            text NOT NULL
                       CHECK (outcome IN ('approve', 'approve_with_edits', 'request_changes', 'reject')),
  justification      text,
  decided_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Anything that sends work back states why. "Rejected" alone is not feedback.
  CONSTRAINT review_decision_returned_work_is_explained
    CHECK (outcome IN ('approve', 'approve_with_edits')
           OR length(btrim(coalesce(justification, ''))) > 0)
);

CREATE INDEX review_decision_owner_idx
  ON content.review_decision (owner_type, owner_version_id, decided_at DESC);

-- The usage graph. One edge per (owner version, asset version) relationship,
-- however many times the document mentions it — counting mentions would report
-- an asset as unused the moment a caption changed.
CREATE TABLE content.content_media_ref (
  owner_type             text NOT NULL CHECK (owner_type IN ('item_version', 'stimulus_version', 'solution_version')),
  owner_version_id       uuid NOT NULL,
  media_asset_version_id uuid NOT NULL REFERENCES content.media_asset_version (asset_version_id),

  PRIMARY KEY (owner_type, owner_version_id, media_asset_version_id)
);

CREATE INDEX content_media_ref_asset_idx ON content.content_media_ref (media_asset_version_id);

-- ───────────────────────────────────────── locale variants (H1) ──
-- Modeled now so H1 does not migrate a corpus (FR-QM-11, M3-16). Nothing
-- writes it this milestone.

CREATE TABLE content.item_version_locale (
  item_version_id     uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  locale              text NOT NULL CHECK (length(btrim(locale)) > 0),
  stem_body           jsonb NOT NULL,
  stem_body_schema_version integer NOT NULL DEFAULT 1,
  stem_plain_text     text NOT NULL,
  options             jsonb NOT NULL DEFAULT '[]'::jsonb,
  options_schema_version integer NOT NULL DEFAULT 1,
  translated_by_kind  text NOT NULL CHECK (translated_by_kind IN ('human', 'ai_agent', 'system')),
  translated_by_id    uuid NOT NULL,
  review_state        text NOT NULL DEFAULT 'draft'
                        CHECK (review_state IN ('draft', 'attested', 'invalidated')),
  attested_by_id      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (item_version_id, locale),
  CONSTRAINT item_version_locale_attested_has_attester
    CHECK (review_state <> 'attested' OR attested_by_id IS NOT NULL),
  CONSTRAINT item_version_locale_attester_is_not_translator
    CHECK (attested_by_id IS NULL OR attested_by_id <> translated_by_id)
);

-- +migrate Down

DROP TABLE IF EXISTS content.item_version_locale;
DROP TABLE IF EXISTS content.review_decision;
DROP TABLE IF EXISTS content.content_media_ref;
ALTER TABLE IF EXISTS content.media_asset DROP CONSTRAINT IF EXISTS media_asset_published_version_fk;
DROP TABLE IF EXISTS content.media_asset_version;
DROP TABLE IF EXISTS content.media_asset;
DROP TABLE IF EXISTS content.alternate_approach;
DROP TABLE IF EXISTS content.distractor_analysis;
DROP TABLE IF EXISTS content.solution_step;
ALTER TABLE IF EXISTS content.solution DROP CONSTRAINT IF EXISTS solution_published_version_fk;
DROP TABLE IF EXISTS content.solution_version;
DROP TABLE IF EXISTS content.solution;
DROP TABLE IF EXISTS content.content_licensing;
DROP TABLE IF EXISTS content.item_provenance;
DROP TABLE IF EXISTS content.item_taxonomy_tag;
DROP TABLE IF EXISTS content.item_numeric_spec;
DROP TABLE IF EXISTS content.item_matching_pair;
DROP TABLE IF EXISTS content.item_matching_member;
DROP TABLE IF EXISTS content.item_option;
ALTER TABLE IF EXISTS content.item DROP CONSTRAINT IF EXISTS item_published_version_fk;
DROP TABLE IF EXISTS content.item_version;
DROP TABLE IF EXISTS content.item;
ALTER TABLE IF EXISTS content.stimulus DROP CONSTRAINT IF EXISTS stimulus_published_version_fk;
DROP TABLE IF EXISTS content.stimulus_version;
DROP TABLE IF EXISTS content.stimulus;
DROP DOMAIN IF EXISTS content.lifecycle_state;
DROP FUNCTION IF EXISTS content.uuid_generate_v7();
DROP SCHEMA IF EXISTS content;
