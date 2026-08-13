-- Durable backing for content's `IdempotencyStore` port (M0-08, closes D22).
-- A process-local store makes a retry on another instance a redundant
-- rewrite; this is the wiring change that port's own comment already named.
--
-- Platform-owned, no cross-schema foreign key (F2) — the key is an opaque
-- caller-chosen string, never a reference to a row in a context schema.
--
-- One row per key, ever. `remember` is `INSERT ... ON CONFLICT DO NOTHING`:
-- the uniqueness constraint is what makes two concurrent inserts for the
-- same key resolve to one row, not a SELECT-then-INSERT the adapter does
-- itself — a read-then-write race is exactly what this schema exists to
-- avoid.

-- +migrate Up

CREATE TABLE platform.idempotency_key (
  idempotency_key text        PRIMARY KEY CHECK (length(btrim(idempotency_key)) > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

-- Expiry reaping scans this; `seen` also filters on it directly on the
-- primary-key lookup, so the index earns its keep on the reap path alone.
CREATE INDEX idempotency_key_expires_at_idx ON platform.idempotency_key (expires_at);

-- +migrate Down

DROP TABLE IF EXISTS platform.idempotency_key;
