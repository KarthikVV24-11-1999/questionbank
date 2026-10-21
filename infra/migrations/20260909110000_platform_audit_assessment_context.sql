-- +migrate Up

-- The assessment context records its commands through the same durable recorder
-- as the other four (M6-22). The table's CHECK named four contexts, so the first
-- assessment command under the real recorder would have been refused; the handler
-- specs use a recording double and would not have met it. This widens the set by
-- one value and changes no row.
ALTER TABLE platform.audit_record DROP CONSTRAINT audit_record_target_context_check;
ALTER TABLE platform.audit_record
  ADD CONSTRAINT audit_record_target_context_check
  CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation', 'assessment'));

-- +migrate Down

-- The table is append-only, so assessment rows already written cannot be removed to make the narrower
-- set true. NOT VALID restores the rule for every row written from here on and leaves those rows as they are.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'audit_record') THEN
    ALTER TABLE platform.audit_record DROP CONSTRAINT IF EXISTS audit_record_target_context_check;
    ALTER TABLE platform.audit_record
      ADD CONSTRAINT audit_record_target_context_check
      CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation')) NOT VALID;
  END IF;
END $$;
