-- `content.item.authoring_subject` (M4-14a) — the routing key a
-- subject-scoped review queue needs (DEC-M4-8). Content authorizes a
-- declared subject on every other authoring command (stimulus, solution,
-- media, import) and stores it nowhere; items had no subject concept in the
-- model at all until M4-14 resolved one from the principal's own scope.
--
-- 'unclassified' backfills rows written before subject tracking existed —
-- there is no source to derive a real value from for them, and an honest
-- placeholder that sorts to its own queue bucket is better than a fabricated
-- guess at what subject they belong to.

-- +migrate Up

ALTER TABLE content.item ADD COLUMN authoring_subject text;
UPDATE content.item SET authoring_subject = 'unclassified' WHERE authoring_subject IS NULL;
ALTER TABLE content.item ALTER COLUMN authoring_subject SET NOT NULL;
-- Same discipline as state_entered_at's own now() default: a raw INSERT that
-- does not mention this column (a schema-level fixture, a script) still
-- gets a value rather than tripping the NOT NULL constraint. The
-- application always supplies a resolved value; this default is a safety
-- net for everything else, not the intended path.
ALTER TABLE content.item ALTER COLUMN authoring_subject SET DEFAULT 'unclassified';
ALTER TABLE content.item ADD CONSTRAINT item_authoring_subject_not_blank
  CHECK (length(btrim(authoring_subject)) > 0);

-- +migrate Down

-- Safe no-op against a schema-less database, and database-scoped only — the
-- same discipline `20260819120000_content_state_entered_at.sql` states
-- (itself correcting `20260814100000_app_role.sql`'s mistake): this touches
-- content.item alone, never a cluster object.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'content' AND table_name = 'item' AND column_name = 'authoring_subject'
  ) THEN
    ALTER TABLE content.item DROP COLUMN authoring_subject;
  END IF;
END
$$;
