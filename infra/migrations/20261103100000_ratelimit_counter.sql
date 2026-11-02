-- Counters for the rate limiter's Postgres adapter (M8-06). One row per (key, window length, window start): the adapter creates or increments it in a
-- single statement, so two instances counting the same key are serialised by the row lock and not by anything the application does.
--
-- Its own schema, not `platform`: everything in `platform` is append-only for the application role by rule (the audit log, the idempotency ledger, the outbox), and a counter is the
-- opposite kind of table, updated on every hit and cleared when its window has passed. Putting it there would have meant an exception to a rule that is worth having whole.
--
-- Opaque, like the idempotency ledger: the key is a hash the caller built, never an address or a person, and there is no foreign key to a context (F2). A row is worth keeping until
-- its window ends; `expires_at` is when, and the scheduler removes what has passed it.

-- +migrate Up

CREATE SCHEMA ratelimit;

CREATE TABLE ratelimit.counter (
  counter_key  text        NOT NULL CHECK (length(counter_key) BETWEEN 1 AND 200),
  window_ms    integer     NOT NULL CHECK (window_ms BETWEEN 1000 AND 86400000),
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  hits         integer     NOT NULL CHECK (hits >= 1),
  PRIMARY KEY (counter_key, window_ms, window_start)
);

CREATE INDEX counter_expires_at_idx ON ratelimit.counter (expires_at);

-- Conditional, as the other grants are, so a database without the role yet is not a broken migration. No TRUNCATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT USAGE ON SCHEMA ratelimit TO questionbank_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ratelimit.counter TO questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP SCHEMA IF EXISTS ratelimit CASCADE;
