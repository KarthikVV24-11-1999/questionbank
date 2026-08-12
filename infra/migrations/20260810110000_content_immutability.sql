-- Published content versions are immutable, enforced at the database (INV-03).
--
-- **This differs deliberately from scoring's append-only rule.** A score record
-- is append-only from the moment it exists; a content version is *editable
-- while it is a draft* and immutable from the moment it is published. That is
-- the whole point of the draft state, and a blanket append-only rule would
-- make authoring impossible.
--
-- The trigger keys on `published_at`, added here because it exists for this
-- rule. "Ever published" is the right test rather than "currently published":
-- a version that was published and then superseded must still be reproducible,
-- because an attempt is pinned to it (INV-04).
--
-- Row triggers do not fire on TRUNCATE. That path is closed by withholding the
-- grant (§9 rule 11), below — but note that UPDATE and DELETE grants are
-- *kept*, because drafts legitimately need them. Here the trigger is the
-- control and the grant is the backstop, which is the reverse of scoring.

-- +migrate Up

ALTER TABLE content.item_version        ADD COLUMN published_at timestamptz;
ALTER TABLE content.stimulus_version    ADD COLUMN published_at timestamptz;
ALTER TABLE content.solution_version    ADD COLUMN published_at timestamptz;
ALTER TABLE content.media_asset_version ADD COLUMN published_at timestamptz;

-- A published version never changes and is never deleted. A draft may do both.
CREATE OR REPLACE FUNCTION content.reject_published_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN
    -- Still a draft. Editing is the point.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'content_published_version_is_immutable: %.% was published at %; publish a new version instead (INV-03)',
    TG_TABLE_NAME, TG_OP, OLD.published_at
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER item_version_immutable_once_published
  BEFORE UPDATE OR DELETE ON content.item_version
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_version_mutation();

CREATE TRIGGER stimulus_version_immutable_once_published
  BEFORE UPDATE OR DELETE ON content.stimulus_version
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_version_mutation();

CREATE TRIGGER solution_version_immutable_once_published
  BEFORE UPDATE OR DELETE ON content.solution_version
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_version_mutation();

CREATE TRIGGER media_asset_version_immutable_once_published
  BEFORE UPDATE OR DELETE ON content.media_asset_version
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_version_mutation();

-- A version's parts are the version. Options, tags, provenance, steps and
-- media edges belong to the snapshot, so they freeze with it — otherwise a
-- published item's key could be edited without touching the row that claims to
-- be immutable, which is the exact hole INV-03 exists to close.
--
-- TG_ARGV[0] is the owning version table; TG_ARGV[1] is the column that
-- references it.
CREATE OR REPLACE FUNCTION content.reject_published_child_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject jsonb;
  owner_id uuid;
  owner_published timestamptz;
BEGIN
  subject := CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
  owner_id := (subject ->> TG_ARGV[1])::uuid;

  EXECUTE format(
    'SELECT published_at FROM content.%I WHERE %I = $1', TG_ARGV[0], TG_ARGV[1]
  ) INTO owner_published USING owner_id;

  IF owner_published IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'content_published_version_is_immutable: % belongs to a version published at %; publish a new version instead (INV-03)',
    TG_TABLE_NAME, owner_published
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER item_option_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_option
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER item_numeric_spec_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_numeric_spec
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER item_taxonomy_tag_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_taxonomy_tag
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER item_provenance_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_provenance
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER item_matching_member_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_matching_member
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER item_matching_pair_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.item_matching_pair
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('item_version', 'item_version_id');

CREATE TRIGGER solution_step_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.solution_step
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('solution_version', 'solution_version_id');

CREATE TRIGGER distractor_analysis_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.distractor_analysis
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('solution_version', 'solution_version_id');

CREATE TRIGGER alternate_approach_frozen_with_its_version
  BEFORE INSERT OR UPDATE OR DELETE ON content.alternate_approach
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_child_mutation('solution_version', 'solution_version_id');

-- Licensing freezes with its version too: a published item whose licence could
-- be downgraded to `unresolved` after the fact would be serving content the
-- platform no longer claims a right to, with no record that anything changed.
CREATE OR REPLACE FUNCTION content.reject_published_licensing_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject jsonb;
  owner_published timestamptz;
BEGIN
  subject := CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;

  SELECT published_at INTO owner_published FROM content.item_version
   WHERE subject ->> 'owner_type' = 'item_version'
     AND item_version_id = (subject ->> 'owner_version_id')::uuid;

  IF owner_published IS NULL THEN
    SELECT published_at INTO owner_published FROM content.stimulus_version
     WHERE subject ->> 'owner_type' = 'stimulus_version'
       AND stimulus_version_id = (subject ->> 'owner_version_id')::uuid;
  END IF;

  IF owner_published IS NULL THEN
    SELECT published_at INTO owner_published FROM content.media_asset_version
     WHERE subject ->> 'owner_type' = 'media_asset_version'
       AND asset_version_id = (subject ->> 'owner_version_id')::uuid;
  END IF;

  IF owner_published IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'content_published_version_is_immutable: licensing freezes with the version it covers (published at %)',
    owner_published
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER content_licensing_frozen_with_its_owner
  BEFORE INSERT OR UPDATE OR DELETE ON content.content_licensing
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_licensing_mutation();

-- The media usage graph freezes with its owner too. If it did not, an edge
-- could be removed from a published item and the asset would then look unused
-- — which is exactly the reading FR-QM-06 rule 3 relies on to refuse
-- retirement.
CREATE OR REPLACE FUNCTION content.reject_published_media_ref_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject jsonb;
  owner_published timestamptz;
BEGIN
  subject := CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;

  SELECT published_at INTO owner_published FROM content.item_version
   WHERE subject ->> 'owner_type' = 'item_version'
     AND item_version_id = (subject ->> 'owner_version_id')::uuid;

  IF owner_published IS NULL THEN
    SELECT published_at INTO owner_published FROM content.stimulus_version
     WHERE subject ->> 'owner_type' = 'stimulus_version'
       AND stimulus_version_id = (subject ->> 'owner_version_id')::uuid;
  END IF;

  IF owner_published IS NULL THEN
    SELECT published_at INTO owner_published FROM content.solution_version
     WHERE subject ->> 'owner_type' = 'solution_version'
       AND solution_version_id = (subject ->> 'owner_version_id')::uuid;
  END IF;

  IF owner_published IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'content_published_version_is_immutable: the media usage graph freezes with the version it belongs to (published at %)',
    owner_published
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER content_media_ref_frozen_with_its_owner
  BEFORE INSERT OR UPDATE OR DELETE ON content.content_media_ref
  FOR EACH ROW EXECUTE FUNCTION content.reject_published_media_ref_mutation();

-- §9 rule 11, adapted. UPDATE and DELETE grants are *kept* on the version
-- tables, because a draft is edited through exactly those. TRUNCATE is
-- withheld everywhere, since a row trigger cannot see it — that is the one
-- path where the grant, not the trigger, is the control.
DO $$
DECLARE
  target text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    FOREACH target IN ARRAY ARRAY[
      'item_version', 'stimulus_version', 'solution_version', 'media_asset_version',
      'item_option', 'item_numeric_spec', 'item_taxonomy_tag', 'item_provenance',
      'item_matching_member', 'item_matching_pair', 'solution_step',
      'distractor_analysis', 'alternate_approach', 'content_media_ref',
      'content_licensing'
    ]
    LOOP
      EXECUTE format('REVOKE TRUNCATE ON content.%I FROM questionbank_app', target);
    END LOOP;
  END IF;
END $$;

-- +migrate Down

DROP TRIGGER IF EXISTS content_licensing_frozen_with_its_owner ON content.content_licensing;
DROP TRIGGER IF EXISTS content_media_ref_frozen_with_its_owner ON content.content_media_ref;
DROP TRIGGER IF EXISTS alternate_approach_frozen_with_its_version ON content.alternate_approach;
DROP TRIGGER IF EXISTS distractor_analysis_frozen_with_its_version ON content.distractor_analysis;
DROP TRIGGER IF EXISTS solution_step_frozen_with_its_version ON content.solution_step;
DROP TRIGGER IF EXISTS item_matching_pair_frozen_with_its_version ON content.item_matching_pair;
DROP TRIGGER IF EXISTS item_matching_member_frozen_with_its_version ON content.item_matching_member;
DROP TRIGGER IF EXISTS item_provenance_frozen_with_its_version ON content.item_provenance;
DROP TRIGGER IF EXISTS item_taxonomy_tag_frozen_with_its_version ON content.item_taxonomy_tag;
DROP TRIGGER IF EXISTS item_numeric_spec_frozen_with_its_version ON content.item_numeric_spec;
DROP TRIGGER IF EXISTS item_option_frozen_with_its_version ON content.item_option;
DROP TRIGGER IF EXISTS media_asset_version_immutable_once_published ON content.media_asset_version;
DROP TRIGGER IF EXISTS solution_version_immutable_once_published ON content.solution_version;
DROP TRIGGER IF EXISTS stimulus_version_immutable_once_published ON content.stimulus_version;
DROP TRIGGER IF EXISTS item_version_immutable_once_published ON content.item_version;
DROP FUNCTION IF EXISTS content.reject_published_licensing_mutation();
DROP FUNCTION IF EXISTS content.reject_published_media_ref_mutation();
DROP FUNCTION IF EXISTS content.reject_published_child_mutation();
DROP FUNCTION IF EXISTS content.reject_published_version_mutation();
ALTER TABLE IF EXISTS content.media_asset_version DROP COLUMN IF EXISTS published_at;
ALTER TABLE IF EXISTS content.solution_version    DROP COLUMN IF EXISTS published_at;
ALTER TABLE IF EXISTS content.stimulus_version    DROP COLUMN IF EXISTS published_at;
ALTER TABLE IF EXISTS content.item_version        DROP COLUMN IF EXISTS published_at;
