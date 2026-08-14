-- The deployed application's own database role (M0-24, closes D9). Idempotent
-- so a re-run migration is a no-op, not an error — `CREATE ROLE` has no
-- `IF NOT EXISTS` form, so this checks the catalogue first.
--
-- NOLOGIN, and no password anywhere in source (F39): locally this role is
-- never connected to directly, only granted through; in staging the deployed
-- credential comes from AWS Secrets Manager (TECH-STACK §10) and is set out
-- of band, by a role with CREATEROLE — a Terraform/runbook fact, not this
-- migration's.
--
-- Grants: SELECT/INSERT/UPDATE/DELETE broadly across content, curriculum and
-- scoring — a draft is editable and a published version is frozen by trigger
-- (INV-03), not by grant, which is what lets one grant set serve both states
-- without the app role's privileges changing on publish. TRUNCATE is granted
-- nowhere: Postgres never grants it implicitly, so simply never naming it is
-- the whole enforcement.
--
-- `platform` is different in kind, not degree: every table there is
-- append-only by design (the audit log, the idempotency ledger, the outbox),
-- so the app role gets SELECT/INSERT only — no UPDATE, no DELETE, matching
-- what `platform.audit_record`'s own trigger already refuses at the row
-- level, enforced here at the grant level too.

-- +migrate Up

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    CREATE ROLE questionbank_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA content, curriculum, scoring, platform TO questionbank_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA content TO questionbank_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA curriculum TO questionbank_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scoring TO questionbank_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA platform TO questionbank_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO questionbank_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA curriculum GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO questionbank_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA scoring GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO questionbank_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT ON TABLES TO questionbank_app;

-- +migrate Down

-- `revertMigrations()` in test support runs every down script against
-- whatever state the database happens to be in, including a schema-less
-- one — every prior migration's down is written to be a safe no-op there,
-- and this one now is too. `DROP OWNED BY` revokes every privilege and
-- default-privilege entry this role holds, across every schema, in one
-- existence-guarded statement, rather than one REVOKE per schema that
-- throws the moment a schema is not there to revoke on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    EXECUTE 'DROP OWNED BY questionbank_app';
  END IF;
END
$$;

DROP ROLE IF EXISTS questionbank_app;
