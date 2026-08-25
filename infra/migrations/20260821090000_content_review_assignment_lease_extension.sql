-- ExtendLease (M4-27) needs `review_assignment.lease_expires_at` to move
-- while `state` stays `'claimed'` — the M4-21 trigger
-- (`content.reject_disallowed_review_assignment_change`) currently freezes
-- that column absolutely, on every write. This migration restructures the
-- trigger to carve out exactly one exception, rather than removing
-- `lease_expires_at` from the frozen-column list wholesale — the latter
-- would also let it change during `claimed -> released` and
-- `claimed -> decided`, which is a real regression this migration's own
-- planted violations prove against.
--
-- **The new case, and only it:** `state` unchanged at `'claimed'`,
-- `lease_expires_at` **strictly** later than before, `decided_at` and
-- `released_at` both still `NULL`, `aggregate_version` advances by exactly
-- one, and every other column identical. Anything else — a shortened lease,
-- an unchanged one, a second column moving alongside it, or a state change
-- carrying a lease change — still falls through to the original frozen-column
-- check and is refused exactly as before.
--
-- **The extension window itself is bounded in the handler, not here.**
-- `ExtendLeaseHandler` reads the cap from `ReviewPolicy` (M4-26) the same way
-- every other review threshold lives in typed config; this trigger's job is
-- the tamper *shape* — forward, alone, versioned — not the policy number.
--
-- **Extension does not defeat FR-ADM-05.** Queue ageing and escalation
-- (`domain/review/ageing.ts`) are measured from `stateEnteredAt` on the
-- *item*, never from the assignment's lease. An item held through repeated
-- lease extensions still ages against its own clock and still escalates to
-- Content Ops — the safety net DEC-M4-1 already built does not need to know
-- this command exists.

-- +migrate Up

CREATE OR REPLACE FUNCTION content.reject_disallowed_review_assignment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review_assignment_is_never_deleted: expiry and release are transitions, not deletions'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Every column but the state machine's own is fixed at claim time.
  -- `lease_expires_at` is deliberately absent from this list now — its one
  -- permitted movement is checked in the claimed -> claimed branch below,
  -- and every other path re-freezes it explicitly.
  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.item_version_id IS DISTINCT FROM OLD.item_version_id
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.reviewer_kind IS DISTINCT FROM OLD.reviewer_kind
     OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'review_assignment_only_the_state_machine_may_change: every column but the state machine''s own is fixed at claim time'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The lease-extension case (M4-27, ExtendLease), and the only case in
  -- which `state` does not change. Handled first and returned early: the
  -- transition table below names moves *out of* 'claimed', and staying in it
  -- is not one of those, so it must never reach that check.
  IF OLD.state = 'claimed' AND NEW.state = 'claimed' THEN
    IF NEW.lease_expires_at <= OLD.lease_expires_at THEN
      RAISE EXCEPTION 'review_assignment_lease_extension_must_move_forward: % is not after %',
        NEW.lease_expires_at, OLD.lease_expires_at
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.decided_at IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'review_assignment_lease_extension_touches_no_other_column'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version + 1 THEN
      RAISE EXCEPTION 'review_assignment_aggregate_version_must_advance_by_one'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Every other case: the lease is frozen, exactly as it was before this
  -- migration — a state transition never moves it.
  IF NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
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

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only. Restores
-- the M4-21 function body exactly — `lease_expires_at` frozen absolutely,
-- with no claimed -> claimed carve-out — rather than dropping the function,
-- since the trigger (created in M4-21's migration) still points at it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'content') THEN
    IF EXISTS (
      SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'content' AND p.proname = 'reject_disallowed_review_assignment_change'
    ) THEN
      CREATE OR REPLACE FUNCTION content.reject_disallowed_review_assignment_change() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
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
      END $fn$;
    END IF;
  END IF;
END
$$;
