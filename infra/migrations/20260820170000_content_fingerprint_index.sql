-- The trigram narrowing index (M4-20, DEC-M4-2's retrieval half).
--
-- `content.item_fingerprint` and its exact/skeleton B-tree indexes already
-- exist (M4-17) — those are the authoritative lookups, exact-match and
-- therefore cheap without this extension at all. This migration adds only
-- the narrowing path: `pg_trgm` and a GIN index over `normalized_text`.
--
-- **If the extension is unavailable, this fails loudly.** No guard, no
-- catch — `CREATE EXTENSION` raises the server's own error, and the
-- migration does not apply. `FingerprintRepository`'s fallback (a full scan,
-- identical results, slower) is a repository-level decision made by
-- checking `pg_extension` at query time, never something this file decides
-- by swallowing a failure.

-- +migrate Up

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX item_fingerprint_normalized_text_trgm_idx
  ON content.item_fingerprint USING gin (normalized_text gin_trgm_ops);

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only. The
-- extension itself is left installed — dropping it is a cluster-adjacent
-- decision this migration does not need to make to reverse what it added,
-- and nothing here depends on it being absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'content' AND indexname = 'item_fingerprint_normalized_text_trgm_idx'
  ) THEN
    DROP INDEX content.item_fingerprint_normalized_text_trgm_idx;
  END IF;
END
$$;
