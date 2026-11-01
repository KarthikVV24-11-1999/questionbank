-- +migrate Up

-- The identity context's tables (M8-01): who a person is, how they prove it, and the sessions that prove it again on every request.
-- Credentials are ours, and a credential is stored with the parameters it was hashed under, so that strengthening the hash is a rehash on the next
-- login and never a reset (ADR-0056). Nothing here holds a password, a session token or a one-time token in the clear: a row that leaks is a set of
-- hashes, not a set of live logins.
CREATE SCHEMA identity;

CREATE TABLE identity.app_user (
  user_id           uuid        PRIMARY KEY,
  email             text        NOT NULL CHECK (length(btrim(email)) BETWEEN 3 AND 254),
  -- Lower-cased and trimmed: the key an address is looked up and made unique by, so Asha@x and asha@x are one person.
  email_normalized  text        NOT NULL UNIQUE CHECK (email_normalized = lower(btrim(email_normalized))),
  email_verified_at timestamptz,
  -- Role assignment is Identity's (ADR-0014). A user has at least one; the vocabulary is the application's (`platform/auth/roles.ts`) and is checked there.
  roles             text[]      NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 8),
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL
);

-- One credential per user. The columns are the parameters the hash was made under, read back at verification, so a user hashed under N=2^16 and one hashed under
-- a later, stronger N are both verified correctly and the first is rehashed when they next log in. `SELECT count(*) WHERE n < <the new N>` is how many are left.
CREATE TABLE identity.credential (
  user_id     uuid        PRIMARY KEY REFERENCES identity.app_user (user_id),
  algorithm   text        NOT NULL CHECK (algorithm = 'scrypt'),
  n           integer     NOT NULL CHECK (n >= 1024 AND (n & (n - 1)) = 0),
  r           integer     NOT NULL CHECK (r >= 1),
  p           integer     NOT NULL CHECK (p >= 1),
  key_length  integer     NOT NULL CHECK (key_length >= 16),
  salt        bytea       NOT NULL CHECK (octet_length(salt) >= 16),
  hash        bytea       NOT NULL,
  changed_at  timestamptz NOT NULL,
  CHECK (octet_length(hash) = key_length)
);

-- A session is its token's SHA-256 and what is known about it. The token is 32 random bytes shown once, to the person it was issued to.
CREATE TABLE identity.session (
  session_id     uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES identity.app_user (user_id),
  token_hash     bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text        CHECK (revoked_reason IN ('logout', 'logout_all', 'rotated', 'device_limit', 'password_changed', 'password_reset', 'disabled')),
  -- The session this one replaced when it was rotated.
  rotated_from   uuid        REFERENCES identity.session (session_id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- The live sessions of a user, oldest first: the device limit reads exactly this.
CREATE INDEX session_live_by_user ON identity.session (user_id, created_at) WHERE revoked_at IS NULL;

-- Email verification and password recovery share one shape: single-use, time-boxed, hashed at rest, and replaced by a second issue.
CREATE TABLE identity.one_time_token (
  token_id      uuid        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES identity.app_user (user_id),
  purpose       text        NOT NULL CHECK (purpose IN ('email_verification', 'password_recovery')),
  token_hash    bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  superseded_at timestamptz
);

CREATE INDEX one_time_token_open_by_user ON identity.one_time_token (user_id, purpose) WHERE used_at IS NULL AND superseded_at IS NULL;

-- Identity's consequential commands are audited through the same chain as every other context's.
ALTER TABLE platform.audit_record DROP CONSTRAINT audit_record_target_context_check;
ALTER TABLE platform.audit_record
  ADD CONSTRAINT audit_record_target_context_check
  CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation', 'assessment', 'learning', 'identity'));

-- The application role reads and writes these, and deletes none of it: a user is disabled, a session revoked, a token used. Written conditionally, as the other
-- contexts' grants are, so a database without the role yet is not a broken migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    GRANT USAGE ON SCHEMA identity TO questionbank_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity TO questionbank_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT SELECT, INSERT, UPDATE ON TABLES TO questionbank_app;
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA identity FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'audit_record') THEN
    ALTER TABLE platform.audit_record DROP CONSTRAINT IF EXISTS audit_record_target_context_check;
    ALTER TABLE platform.audit_record
      ADD CONSTRAINT audit_record_target_context_check
      CHECK (target_context IN ('content', 'curriculum', 'scoring', 'generation', 'assessment', 'learning')) NOT VALID;
  END IF;
END $$;

DROP SCHEMA IF EXISTS identity CASCADE;
