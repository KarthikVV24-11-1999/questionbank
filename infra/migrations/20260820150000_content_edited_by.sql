-- `content.item_version.edited_by_*` (M4-15, ADR-0018) — the reviewer-edit
-- half of approve-with-edits. Nullable: only a version the approve-with-edits
-- path derived carries one, and `authored_by_*` is never rewritten (INV-02,
-- INV-03 both forbid it — an edit produces a new version, it does not
-- reattribute the old one).

-- +migrate Up

ALTER TABLE content.item_version ADD COLUMN edited_by_kind text
  CHECK (edited_by_kind IN ('human', 'ai_agent', 'system'));
ALTER TABLE content.item_version ADD COLUMN edited_by_id uuid;
ALTER TABLE content.item_version ADD CONSTRAINT item_version_edited_by_both_or_neither
  CHECK ((edited_by_kind IS NULL) = (edited_by_id IS NULL));

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only — the same
-- discipline `20260819120000_content_state_entered_at.sql` and
-- `20260820090000_content_authoring_subject.sql` already state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'content' AND table_name = 'item_version' AND column_name = 'edited_by_kind'
  ) THEN
    ALTER TABLE content.item_version DROP COLUMN edited_by_kind;
    ALTER TABLE content.item_version DROP COLUMN edited_by_id;
  END IF;
END
$$;
