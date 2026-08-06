-- Transactional outbox (DATA-ARCHITECTURE P4). Cross-context events are written
-- in the same transaction as the aggregate change and drained by the relay.
-- Platform-owned, so no foreign key points into a context schema (F2).

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.outbox_message (
  outbox_message_id uuid PRIMARY KEY DEFAULT curriculum.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  event_type        text        NOT NULL CHECK (length(btrim(event_type)) > 0),
  schema_version    integer     NOT NULL CHECK (schema_version >= 1),
  aggregate_type    text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  payload           jsonb       NOT NULL,
  payload_schema_version integer NOT NULL DEFAULT 1,
  principal_kind    text        NOT NULL CHECK (principal_kind IN ('human', 'ai_agent', 'system')),
  principal_id      uuid        NOT NULL,
  correlation_id    text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  published_at      timestamptz,
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

-- The relay reads the unpublished backlog in occurrence order.
CREATE INDEX outbox_message_unpublished_idx
  ON platform.outbox_message (occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_message_aggregate_idx ON platform.outbox_message (aggregate_type, aggregate_id);

-- +migrate Down

DROP TABLE IF EXISTS platform.outbox_message;
DROP SCHEMA IF EXISTS platform;
