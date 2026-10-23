-- +migrate Up

-- The relay's bookkeeping on the outbox (D17). A message is *claimed* for a lease, delivered, and then published; a failure
-- leaves it claimable again after a back-off; a message that keeps failing is dead-lettered, which stops it being claimed and
-- keeps it for an operator. Nothing here is read by a context: the table belongs to platform.
ALTER TABLE platform.outbox_message
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN retry_at      timestamptz,
  ADD COLUMN dead_at       timestamptz,
  ADD COLUMN last_error    text;

-- The relay reads the live backlog (neither published nor dead) in occurrence order.
DROP INDEX IF EXISTS platform.outbox_message_unpublished_idx;
CREATE INDEX outbox_message_live_idx
  ON platform.outbox_message (occurred_at, outbox_message_id)
  WHERE published_at IS NULL AND dead_at IS NULL;

-- A message is published or dead, not both.
ALTER TABLE platform.outbox_message
  ADD CONSTRAINT outbox_message_published_xor_dead CHECK (published_at IS NULL OR dead_at IS NULL);

-- The relay's role may update the delivery bookkeeping and nothing about the event: a trigger refuses a change to anything
-- the producing transaction wrote.
CREATE OR REPLACE FUNCTION platform.guard_outbox_message_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.outbox_message_id, NEW.tenant_id, NEW.event_type, NEW.schema_version, NEW.aggregate_type, NEW.aggregate_id,
         NEW.payload, NEW.payload_schema_version, NEW.principal_kind, NEW.principal_id, NEW.correlation_id, NEW.occurred_at)
     IS DISTINCT FROM
     ROW(OLD.outbox_message_id, OLD.tenant_id, OLD.event_type, OLD.schema_version, OLD.aggregate_type, OLD.aggregate_id,
         OLD.payload, OLD.payload_schema_version, OLD.principal_kind, OLD.principal_id, OLD.correlation_id, OLD.occurred_at)
  THEN
    RAISE EXCEPTION 'platform_outbox_event_is_immutable: message % changed something other than its delivery state', OLD.outbox_message_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_message_event_immutable
  BEFORE UPDATE ON platform.outbox_message
  FOR EACH ROW EXECUTE FUNCTION platform.guard_outbox_message_update();

-- The application role may move a message through delivery, column by column, and may not touch the event. This is a column
-- grant, not a table grant: the table stays append-only for everything the producing transaction wrote, and F40 (no table-level
-- UPDATE on a platform table) still holds. The trigger above refuses the same change even to a role that has the privilege.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT UPDATE (published_at, attempts, claimed_until, retry_at, dead_at, last_error) ON platform.outbox_message TO questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP TRIGGER IF EXISTS outbox_message_event_immutable ON platform.outbox_message;
DROP FUNCTION IF EXISTS platform.guard_outbox_message_update();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'outbox_message') THEN
    ALTER TABLE platform.outbox_message DROP CONSTRAINT IF EXISTS outbox_message_published_xor_dead;
    DROP INDEX IF EXISTS platform.outbox_message_live_idx;
    ALTER TABLE platform.outbox_message DROP COLUMN IF EXISTS claimed_until, DROP COLUMN IF EXISTS retry_at, DROP COLUMN IF EXISTS dead_at, DROP COLUMN IF EXISTS last_error;
    CREATE INDEX IF NOT EXISTS outbox_message_unpublished_idx ON platform.outbox_message (occurred_at) WHERE published_at IS NULL;
  END IF;
END $$;
