-- The assessment context's physical schema (DOMAIN-MODEL §6, ASSESSMENT-ENGINE §5, §12).
-- Patterns applied: P6 UUIDv7 keys, P7 tenant_id.
--
-- `assessment` is its own schema, owned by the assessment context and migrated
-- independently of the others.
--
-- Fitness and invariants enforced here:
--   F5   every JSONB column has a sibling *_schema_version
--   §9 rule 3: no foreign key crosses a schema boundary. Nothing here references
--        `curriculum.*` or `content.*`: the exam profile version, the item
--        versions and the taxonomy version an attempt pins are identifiers the
--        application carries, never joins. Foreign keys *within* `assessment`
--        are fine and are used.
--   §12  what cannot be reconstructed later is NOT NULL, not a convention:
--          form_slot.is_anchor                 anchor items in every form
--          attempt.session_id, attempt.shift_id   session and shift identity
--          response_event.item_version_id      the item VERSION pinned per response
--          response_event.client_monotonic_ms  per-item timing
--          response_event (one row per change) the full answer-change sequence
--
-- The pin cannot disagree with its slot. A response carries the item version as
-- a column of its own (so "which responses were sat on version v" needs no
-- join), and a composite foreign key to the attempt's slot makes the database
-- refuse a response whose version differs from the one the slot pinned.
--
-- One active mock attempt per student (ASSESSMENT-ENGINE §5, ADR-0030) is a
-- partial unique index over the two live states. It can only be an index
-- because "active" is a fact about the stored state and never about the clock.
--
-- Immutability and append-only rules, and the grants, are the paired migration.

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS assessment;

-- Time-ordered identifiers (P6), owned by this schema so the contexts can be
-- migrated independently.
CREATE OR REPLACE FUNCTION assessment.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes PLACING unix_ts_ms FROM 1 FOR 6);
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$;

-- ─────────────────────────────────────────────────────────────────── form ──

CREATE TABLE assessment.form (
  form_id                              uuid PRIMARY KEY DEFAULT assessment.uuid_generate_v7(),
  tenant_id                            uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  exam_profile_version_id              uuid NOT NULL,
  form_type                            text NOT NULL CHECK (form_type IN ('mock', 'diagnostic')),
  -- Embargoed, active and closed arrive with scheduling; a state joins the
  -- vocabulary the day something constructs it.
  state                                text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  blueprint_conformance                jsonb NOT NULL CHECK (jsonb_typeof(blueprint_conformance) = 'object'),
  blueprint_conformance_schema_version integer NOT NULL DEFAULT 1 CHECK (blueprint_conformance_schema_version > 0),
  published_at                         timestamptz,
  created_at                           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT form_published_at_matches_state CHECK ((state = 'published') = (published_at IS NOT NULL)),
  -- The target of attempt's composite foreign key: an attempt names the form,
  -- the profile version and the kind it was built from, and cannot disagree.
  CONSTRAINT form_identity_key UNIQUE (form_id, exam_profile_version_id, form_type)
);

CREATE TABLE assessment.form_section (
  form_id          uuid NOT NULL REFERENCES assessment.form (form_id),
  ordinal          integer NOT NULL CHECK (ordinal >= 0),
  section_spec_ref text NOT NULL CHECK (length(btrim(section_spec_ref)) > 0),

  PRIMARY KEY (form_id, ordinal)
);

CREATE TABLE assessment.form_slot (
  slot_id               uuid PRIMARY KEY,
  form_id               uuid NOT NULL,
  section_ordinal       integer NOT NULL,
  ordinal               integer NOT NULL CHECK (ordinal >= 0),
  item_id               uuid NOT NULL,
  -- INV-04: the version, not the item.
  item_version_id       uuid NOT NULL,
  stimulus_version_id   uuid,
  marks_available       integer NOT NULL CHECK (marks_available > 0),
  -- §12: every slot says. Not nullable, not defaulted.
  is_anchor             boolean NOT NULL,

  CONSTRAINT form_slot_section_fkey FOREIGN KEY (form_id, section_ordinal)
    REFERENCES assessment.form_section (form_id, ordinal),
  CONSTRAINT form_slot_ordinal_key UNIQUE (form_id, ordinal),
  -- An item appears in a form once.
  CONSTRAINT form_slot_item_key UNIQUE (form_id, item_id)
);

-- ───────────────────────────────────────────────────────────────── attempt ──

CREATE TABLE assessment.attempt (
  attempt_id                      uuid PRIMARY KEY DEFAULT assessment.uuid_generate_v7(),
  tenant_id                       uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  student_id                      uuid NOT NULL,
  mode                            text NOT NULL CHECK (mode IN ('mock', 'diagnostic')),
  form_id                         uuid NOT NULL,
  exam_profile_version_id         uuid NOT NULL,
  -- The pin (INV-04). The item versions are on attempt_slot.
  marking_rule_set_hash           text NOT NULL CHECK (marking_rule_set_hash ~ '^[0-9a-f]{64}$'),
  taxonomy_version_id             uuid NOT NULL,
  delivery_policy                 jsonb NOT NULL CHECK (jsonb_typeof(delivery_policy) = 'object'),
  delivery_policy_schema_version  integer NOT NULL DEFAULT 1 CHECK (delivery_policy_schema_version > 0),
  -- §12: session and shift identity. Not nullable.
  session_id                      uuid NOT NULL,
  shift_id                        text NOT NULL CHECK (length(btrim(shift_id)) > 0),
  duration_ms                     bigint NOT NULL CHECK (duration_ms > 0),
  window_closes_at                timestamptz NOT NULL,
  -- Supplied by the application, not defaulted: the domain reads no clock.
  created_at                      timestamptz NOT NULL,

  state                           text NOT NULL DEFAULT 'created'
                                    CHECK (state IN ('created', 'in_progress', 'submitted', 'abandoned')),
  started_at                      timestamptz,
  -- Server-anchored: fixed when the attempt starts and never recomputed.
  deadline_at                     timestamptz,
  submitted_at                    timestamptz,
  submission_reason               text CHECK (submission_reason IN ('manual', 'expiry', 'recovered')),
  idempotency_key                 text CHECK (length(btrim(idempotency_key)) > 0),
  abandoned_at                    timestamptz,

  CONSTRAINT attempt_form_fkey FOREIGN KEY (form_id, exam_profile_version_id, mode)
    REFERENCES assessment.form (form_id, exam_profile_version_id, form_type),

  -- What each state means about the columns that record it, so a row cannot
  -- claim to be submitted without saying when, why and under which key.
  CONSTRAINT attempt_state_shape CHECK (
    (started_at IS NULL) = (deadline_at IS NULL)
    AND CASE state
      WHEN 'created' THEN
        started_at IS NULL AND submitted_at IS NULL AND submission_reason IS NULL
        AND idempotency_key IS NULL AND abandoned_at IS NULL
      WHEN 'in_progress' THEN
        started_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL
        AND idempotency_key IS NULL AND abandoned_at IS NULL
      WHEN 'submitted' THEN
        started_at IS NOT NULL AND submitted_at IS NOT NULL AND submission_reason IS NOT NULL
        AND idempotency_key IS NOT NULL AND abandoned_at IS NULL
      ELSE
        abandoned_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL
        AND idempotency_key IS NULL
    END
  )
);

-- One active mock attempt per student (ASSESSMENT-ENGINE §5, ADR-0030). The
-- predicate is the two live states and nothing about time, which is what lets
-- it be an index: a created attempt past its window is active until something
-- abandons it, and the database refuses a second mock whoever races whom.
CREATE UNIQUE INDEX attempt_one_active_mock_per_student
  ON assessment.attempt (student_id)
  WHERE mode = 'mock' AND state IN ('created', 'in_progress');

CREATE INDEX attempt_student_idx ON assessment.attempt (student_id, created_at);
CREATE INDEX attempt_form_idx ON assessment.attempt (form_id);

-- ──────────────────────────────────────────────────────────── attempt_slot ──
-- The slots as the form had them when the attempt was created: the pin.

CREATE TABLE assessment.attempt_slot (
  attempt_id           uuid NOT NULL REFERENCES assessment.attempt (attempt_id),
  slot_id              uuid NOT NULL,
  ordinal              integer NOT NULL CHECK (ordinal >= 0),
  item_id              uuid NOT NULL,
  item_version_id      uuid NOT NULL,
  stimulus_version_id  uuid,

  PRIMARY KEY (attempt_id, slot_id),
  CONSTRAINT attempt_slot_ordinal_key UNIQUE (attempt_id, ordinal),
  -- The target of response_event's composite foreign key: the pin as the slot recorded it.
  CONSTRAINT attempt_slot_pin_key UNIQUE (attempt_id, slot_id, item_version_id)
);

-- ──────────────────────────────────────────────────────────── response_event ──
-- The authoritative response log (ASSESSMENT-ENGINE §4). The device's engine
-- keeps its own copy and carries no authority here.

CREATE TABLE assessment.response_event (
  event_id             uuid PRIMARY KEY,
  attempt_id           uuid NOT NULL,
  slot_id              uuid NOT NULL,
  -- §12: the item VERSION, pinned per response. Not nullable, and tied to the
  -- slot by the composite key below.
  item_version_id      uuid NOT NULL,
  sequence             bigint NOT NULL CHECK (sequence >= 0),
  kind                 text NOT NULL CHECK (kind IN ('select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag')),
  -- The chosen answer; JSON because it is a string, a number or a list.
  answer               jsonb,
  answer_schema_version integer NOT NULL DEFAULT 1 CHECK (answer_schema_version > 0),
  -- §12: per-item timing. The device's monotonic reading, never a wall clock.
  client_monotonic_ms  bigint NOT NULL CHECK (client_monotonic_ms >= 0),
  server_received_at   timestamptz NOT NULL,
  device_ref           text NOT NULL CHECK (length(btrim(device_ref)) > 0),
  -- Set by the database from the attempt's state when the row is written
  -- (paired migration), never trusted from the caller. True means recorded and
  -- excluded from scoring.
  after_submission     boolean NOT NULL DEFAULT false,

  CONSTRAINT response_event_answer_matches_kind CHECK ((kind IN ('select', 'change')) = (answer IS NOT NULL)),
  CONSTRAINT response_event_pin_matches_slot FOREIGN KEY (attempt_id, slot_id, item_version_id)
    REFERENCES assessment.attempt_slot (attempt_id, slot_id, item_version_id)
);

CREATE INDEX response_event_slot_idx ON assessment.response_event (attempt_id, slot_id, sequence, event_id);
CREATE INDEX response_event_received_idx ON assessment.response_event (attempt_id, server_received_at);
-- "Which responses were sat on this version of this item" — the question
-- statistics attribution depends on — answered without a join.
CREATE INDEX response_event_item_version_idx ON assessment.response_event (item_version_id);

-- +migrate Down

DROP TABLE IF EXISTS assessment.response_event;
DROP TABLE IF EXISTS assessment.attempt_slot;
DROP TABLE IF EXISTS assessment.attempt;
DROP TABLE IF EXISTS assessment.form_slot;
DROP TABLE IF EXISTS assessment.form_section;
DROP TABLE IF EXISTS assessment.form;
DROP FUNCTION IF EXISTS assessment.uuid_generate_v7();
DROP SCHEMA IF EXISTS assessment;
