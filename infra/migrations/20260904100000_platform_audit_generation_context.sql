-- +migrate Up

-- The generation context records its commands through the same durable
-- recorder as the other three (M5-37). The table's CHECK named three contexts, so
-- the first generation command under the real recorder would have been
-- refused; nothing had met that because every generation test used a recording
-- double. This widens the set by one value and changes no row.
ALTER TABLE platform.audit_record DROP CONSTRAINT audit_record_target_context_check;
ALTER TABLE platform.audit_record
  ADD CONSTRAINT audit_record_target_context_check
  CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation'));

-- +migrate Down

-- The table is append-only, so generation rows already written cannot be
-- removed to make the narrower set true. NOT VALID restores the rule for every
-- row written from here on and leaves those rows as they are. Guarded, because
-- reverting a database that is already reverted is something the test harness does.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'audit_record') THEN
    ALTER TABLE platform.audit_record DROP CONSTRAINT IF EXISTS audit_record_target_context_check;
    ALTER TABLE platform.audit_record
      ADD CONSTRAINT audit_record_target_context_check
      CHECK (target_context IN ('content', 'curriculum', 'scoring')) NOT VALID;
  END IF;
END $$;
