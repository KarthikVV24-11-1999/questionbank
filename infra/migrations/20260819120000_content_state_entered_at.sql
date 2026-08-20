-- `content.item.state_entered_at` (M4-13) — the review queue's ageing clock
-- (DEC-M4-1). Content records `created_at` and nothing about *when* an item
-- entered its *current* lifecycle state; a subject-scoped, age-ordered queue
-- needs exactly that fact and does not have it today.
--
-- Backfilled from `created_at` — an item nobody has touched since it was
-- created has been in `draft` since that instant, which is the only honest
-- value a backfill can assign.

-- +migrate Up

ALTER TABLE content.item ADD COLUMN state_entered_at timestamptz;
UPDATE content.item SET state_entered_at = created_at WHERE state_entered_at IS NULL;
ALTER TABLE content.item ALTER COLUMN state_entered_at SET NOT NULL;
ALTER TABLE content.item ALTER COLUMN state_entered_at SET DEFAULT now();

-- +migrate Down

-- Safe no-op against a schema-less database — `revertMigrations()` runs
-- every down script against whatever state the database happens to be in
-- (`testing/database.ts`), and a table that was never created has no column
-- to drop; `information_schema.columns` simply returns no rows for it, so
-- the guard below is enough on its own.
--
-- Database-scoped only, the same discipline
-- `20260814100000_app_role.sql` now states explicitly after getting it
-- wrong: this ALTER TABLE touches `content.item` alone, never a cluster
-- object, so there is nothing here a second database in the cluster could
-- make this fail against.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'content' AND table_name = 'item' AND column_name = 'state_entered_at'
  ) THEN
    ALTER TABLE content.item DROP COLUMN state_entered_at;
  END IF;
END
$$;
