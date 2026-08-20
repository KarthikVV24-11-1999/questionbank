-- The review workspace's own storage (M4-17, DEC-M4-7). Four tables, all
-- inside `content` — the sub-boundary M4-01 enforces is a code boundary
-- (application/review, infrastructure/review), not a schema one, and none of
-- these need a cross-schema FK: every owner they name (`item`, `item_version`,
-- `review_decision`) already lives in `content`.
--
-- `review_assignment` mirrors `ReviewAssignment` (domain/review/review-assignment.ts)
-- field for field. The partial unique index is the concurrency-safe half of
-- "at most one live assignment per item version" — `assertClaimable` in the
-- domain is the pure half; M4-18's claim statement is what makes the index
-- do the enforcing under real concurrency, not a SELECT that races it.
--
-- `item_fingerprint` is the duplicate-detection cache (M4-09/M4-20) — one row
-- per item version, recomputed and replaced, not itself a versioned
-- aggregate, so it carries no `aggregate_version`.
--
-- `review_candidate_shown` is `ReviewDecision.candidatesShownIds` (M4-07)
-- normalized to rows rather than a JSON array, so M4-19's transactional
-- write can insert them with an ordinary multi-row INSERT.
--
-- `review_escalation` targets a role, never a principal (ageing.ts's
-- `escalationTarget`) — there is no reviewer column to reassign to.
--
-- F5: every JSONB column has a `*_schema_version` sibling — none of these four
-- tables have a JSONB column, so none needs one.

-- +migrate Up

CREATE TABLE content.review_assignment (
  assignment_id     uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  item_id           uuid NOT NULL REFERENCES content.item (item_id) ON DELETE CASCADE,
  item_version_id   uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  subject           text NOT NULL,
  reviewer_kind     text NOT NULL CHECK (reviewer_kind IN ('human', 'ai_agent', 'system')),
  reviewer_id       uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('claimed', 'assigned', 'second_review')),
  state             text NOT NULL DEFAULT 'claimed'
                      CHECK (state IN ('claimed', 'decided', 'released', 'expired')),
  claimed_at        timestamptz NOT NULL,
  lease_expires_at  timestamptz NOT NULL,
  released_at       timestamptz,
  decided_at        timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT review_assignment_lease_after_claim CHECK (lease_expires_at > claimed_at)
);

CREATE INDEX review_assignment_item_version_idx ON content.review_assignment (item_version_id);
CREATE INDEX review_assignment_reviewer_idx ON content.review_assignment (reviewer_id, state);

-- The atomic-claim half of M4-02's rule. `state = 'claimed'` is the live set;
-- decided/released/expired assignments are history and may accumulate freely
-- against the same version.
CREATE UNIQUE INDEX review_assignment_one_live_per_version
  ON content.review_assignment (item_version_id) WHERE state = 'claimed';

CREATE TABLE content.item_fingerprint (
  item_version_id   uuid PRIMARY KEY REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  item_id           uuid NOT NULL REFERENCES content.item (item_id) ON DELETE CASCADE,
  subject           text NOT NULL,
  exact_hash        text NOT NULL,
  skeleton_hash     text NOT NULL,
  normalized_text   text NOT NULL,
  computed_at       timestamptz NOT NULL
);

CREATE INDEX item_fingerprint_exact_hash_idx ON content.item_fingerprint (exact_hash);
CREATE INDEX item_fingerprint_skeleton_hash_idx ON content.item_fingerprint (skeleton_hash);
CREATE INDEX item_fingerprint_item_idx ON content.item_fingerprint (item_id);

CREATE TABLE content.review_candidate_shown (
  review_decision_id uuid NOT NULL REFERENCES content.review_decision (review_decision_id) ON DELETE CASCADE,
  candidate_item_id  uuid NOT NULL,
  shown_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (review_decision_id, candidate_item_id)
);

CREATE TABLE content.review_escalation (
  escalation_id   uuid PRIMARY KEY DEFAULT content.uuid_generate_v7(),
  tenant_id       uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  item_id         uuid NOT NULL REFERENCES content.item (item_id) ON DELETE CASCADE,
  item_version_id uuid NOT NULL REFERENCES content.item_version (item_version_id) ON DELETE CASCADE,
  target_role     text NOT NULL DEFAULT 'content_ops' CHECK (target_role = 'content_ops'),
  reason          text NOT NULL,
  escalated_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_escalation_item_version_idx ON content.review_escalation (item_version_id);

-- `review_decision` gains the reject-taxonomy columns (M4-06/M4-07) and the
-- duplicate target it points at when the taxonomy names DUPLICATE. Additive:
-- the append-only rule already holding for this table is untouched.
ALTER TABLE content.review_decision ADD COLUMN reason_code text;
ALTER TABLE content.review_decision ADD COLUMN duplicate_of_item_id uuid REFERENCES content.item (item_id);
ALTER TABLE content.review_decision ADD CONSTRAINT review_decision_duplicate_requires_target
  CHECK (reason_code IS DISTINCT FROM 'DUPLICATE' OR duplicate_of_item_id IS NOT NULL);

-- +migrate Down

-- Safe no-op against a schema-less database, database-scoped only — the same
-- discipline every migration since `20260814100000_app_role.sql`'s fix
-- states.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'content' AND table_name = 'review_decision' AND column_name = 'reason_code'
  ) THEN
    ALTER TABLE content.review_decision DROP CONSTRAINT IF EXISTS review_decision_duplicate_requires_target;
    ALTER TABLE content.review_decision DROP COLUMN IF EXISTS duplicate_of_item_id;
    ALTER TABLE content.review_decision DROP COLUMN IF EXISTS reason_code;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_escalation') THEN
    DROP TABLE content.review_escalation;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_candidate_shown') THEN
    DROP TABLE content.review_candidate_shown;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'item_fingerprint') THEN
    DROP TABLE content.item_fingerprint;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'content' AND table_name = 'review_assignment') THEN
    DROP TABLE content.review_assignment;
  END IF;
END
$$;
