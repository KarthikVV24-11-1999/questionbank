-- §9 rule 11 on the tables M4 adds (M4-21, F7/F40), to M0-24's standard —
-- and the one M3 never applied to `review_decision` at all. M3-28 wrote it
-- append-only *in the repository* (no UPDATE path), which is not the same
-- claim as "the database refuses one" — nothing before this migration
-- stopped a direct UPDATE or DELETE against the row. That gap closes here.
--
-- Two different policies, deliberately, not one copied onto the other:
--
-- `review_decision`, `review_candidate_shown` and `review_escalation` are
-- append-only from the moment a row exists — a reviewer who changes their
-- mind records a second decision (FR-QM-03), and a candidate shown or an
-- escalation raised is a historical fact, not a value anyone revises. They
-- reuse `platform.reject_any_mutation()` rather than a second copy of the
-- same unconditional trigger.
--
-- `review_assignment` is NOT append-only — it is claimed, released,
-- reassigned and escalated, so it mutates by design (M4-02's own state
-- machine). Its trigger is the state machine, not a blanket refusal:
-- `claimed → decided|released|expired` are the only transitions permitted,
-- every other column is compared column-wise and must be unchanged, and no
-- row is ever deleted (nothing in the domain removes one — expiry and
-- release are transitions, not deletions).

-- +migrate Up

CREATE TRIGGER review_decision_append_only
  BEFORE UPDATE OR DELETE ON content.review_decision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER review_candidate_shown_append_only
  BEFORE UPDATE OR DELETE ON content.review_candidate_shown
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

CREATE TRIGGER review_escalation_append_only
  BEFORE UPDATE OR DELETE ON content.review_escalation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_any_mutation();

-- The state machine, enforced column-wise (the M2-19 pattern): every column
-- outside `state`/`decided_at`/`released_at`/`aggregate_version` must be
-- unchanged, the (OLD.state, NEW.state) pair must be one M4-02's own table
-- names, and the stamp that names go with it is exactly the one set.
CREATE OR REPLACE FUNCTION content.reject_disallowed_review_assignment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review_assignment_is_never_deleted: expiry and release are transitions, not deletions'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.item_version_id IS DISTINCT FROM OLD.item_version_id
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.reviewer_kind IS DISTINCT FROM OLD.reviewer_kind
     OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'review_assignment_only_the_state_machine_may_change: every column but the state machine''s own is fixed at claim time'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
    (OLD.state = 'claimed' AND NEW.state = 'decided'  AND NEW.decided_at  IS NOT NULL AND NEW.released_at IS NULL) OR
    (OLD.state = 'claimed' AND NEW.state = 'released'  AND NEW.released_at IS NOT NULL AND NEW.decided_at IS NULL) OR
    (OLD.state = 'claimed' AND NEW.state = 'expired'   AND NEW.decided_at  IS NULL     AND NEW.released_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'review_assignment_transition_not_permitted: % -> % is not one of the machine''s named transitions',
      OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'review_assignment_aggregate_version_must_advance_by_one'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER review_assignment_only_named_transitions
  BEFORE UPDATE OR DELETE ON content.review_assignment
  FOR EACH ROW EXECUTE FUNCTION content.reject_disallowed_review_assignment_change();

-- §9 rule 11: no UPDATE/DELETE/TRUNCATE grant on an append-only review
-- table. `review_assignment` keeps UPDATE (the trigger is the control) but
-- loses DELETE (nothing legitimately deletes one) and TRUNCATE (granted
-- nowhere, the same closed policy every content table holds).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON content.review_decision FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON content.review_candidate_shown FROM questionbank_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON content.review_escalation FROM questionbank_app;
    REVOKE DELETE, TRUNCATE ON content.review_assignment FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

-- Safe no-op against a schema-less database. `DROP TRIGGER IF EXISTS x ON t`
-- still raises when `t` itself does not exist — `IF EXISTS` only guards the
-- trigger name — so each drop is guarded on the table, not just the trigger.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_assignment') THEN
    DROP TRIGGER IF EXISTS review_assignment_only_named_transitions ON content.review_assignment;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_escalation') THEN
    DROP TRIGGER IF EXISTS review_escalation_append_only ON content.review_escalation;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_candidate_shown') THEN
    DROP TRIGGER IF EXISTS review_candidate_shown_append_only ON content.review_candidate_shown;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_decision') THEN
    DROP TRIGGER IF EXISTS review_decision_append_only ON content.review_decision;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS content.reject_disallowed_review_assignment_change();
