-- The error notebook and bookmarks (M7-38).
--
-- **An error entry is made for every response that was wrong, and for every question the learner gave up on, and is cleared by one thing:** a verified
-- mastery transition for the concept it was about. Not a correct re-attempt, and not the passage of time. `resolved_by_transition_id` is that clearing, and the trigger
-- below is what makes it so: it refuses a resolution by a transition that is unverified, a regression, for another learner or concept, or that happened before the
-- entry. An application that tried to clear an entry any other way would be refused by the table.
--
-- A give-up is an entry of its own kind with its own cause (`gave_up`), set by the system and never by the learner: the learner supplies a cause for a wrong response
-- (conceptual, calculation, misread, time, guess) and cannot relabel a give-up. A give-up is not evidence (it is not a response, and D-002 counts responses), so it
-- creates an entry and moves no mastery state.
--
-- Entries are never deleted: they are retained for the life of the account.

-- +migrate Up

CREATE TABLE learning.error_entry (
  error_entry_id           uuid        PRIMARY KEY,
  learner_ref              uuid        NOT NULL,
  attempt_ref              uuid        NOT NULL,
  slot_ref                 text        NOT NULL CHECK (length(btrim(slot_ref)) > 0),
  item_version_ref         uuid        NOT NULL,
  concept_identity_id      uuid        NOT NULL,
  taxonomy_version_id      uuid        NOT NULL,
  kind                     text        NOT NULL CHECK (kind IN ('incorrect', 'gave_up')),
  -- The learner's account of why, for an incorrect response; `gave_up` for a give-up and nothing else.
  error_cause              text        CHECK (error_cause IN ('conceptual', 'calculation', 'misread', 'time', 'guess', 'gave_up')),
  -- The instant of the response (or of the give-up), not of the delivery that carried it.
  occurred_at              timestamptz NOT NULL,
  resolved_by_transition_id uuid       REFERENCES learning.mastery_transition (transition_id),
  recorded_at              timestamptz NOT NULL,
  -- One entry per question per attempt, which is what makes a replayed delivery write nothing more.
  CONSTRAINT error_entry_one_per_slot UNIQUE (attempt_ref, slot_ref),
  CONSTRAINT error_entry_give_up_has_its_own_cause CHECK ((kind = 'gave_up') = (error_cause IS NOT DISTINCT FROM 'gave_up'))
);

CREATE INDEX error_entry_open_by_concept ON learning.error_entry (learner_ref, taxonomy_version_id, concept_identity_id) WHERE resolved_by_transition_id IS NULL;
CREATE INDEX error_entry_by_learner ON learning.error_entry (learner_ref, occurred_at);

CREATE FUNCTION learning.guard_error_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t learning.mastery_transition%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning_error_entry_is_retained: DELETE refused' USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything but the cause and the resolution is fixed when the entry is made.
  IF (to_jsonb(NEW) - 'error_cause' - 'resolved_by_transition_id') IS DISTINCT FROM (to_jsonb(OLD) - 'error_cause' - 'resolved_by_transition_id') THEN
    RAISE EXCEPTION 'learning_error_entry_is_retained: only the cause and the resolution may change' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.error_cause IS DISTINCT FROM OLD.error_cause THEN
    IF OLD.kind = 'gave_up' THEN
      RAISE EXCEPTION 'learning_error_entry_is_retained: a give-up keeps its cause' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.resolved_by_transition_id IS DISTINCT FROM OLD.resolved_by_transition_id THEN
    IF OLD.resolved_by_transition_id IS NOT NULL THEN
      RAISE EXCEPTION 'learning_error_entry_is_retained: an entry is resolved once' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.resolved_by_transition_id IS NULL THEN
      RAISE EXCEPTION 'learning_error_entry_is_retained: a resolution is not withdrawn' USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT * INTO t FROM learning.mastery_transition WHERE transition_id = NEW.resolved_by_transition_id;
    IF NOT FOUND
       OR t.learner_ref <> NEW.learner_ref
       OR t.taxonomy_version_id <> NEW.taxonomy_version_id
       OR t.concept_identity_id <> NEW.concept_identity_id
       OR t.is_regression
       OR t.to_state <> 'strong'
       OR t.verified_at IS NULL
       OR NEW.occurred_at > t.occurred_at THEN
      RAISE EXCEPTION 'learning_error_entry_resolves_only_on_verified_mastery: transition % does not clear this entry', NEW.resolved_by_transition_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER error_entry_guarded
  BEFORE UPDATE OR DELETE ON learning.error_entry
  FOR EACH ROW EXECUTE FUNCTION learning.guard_error_entry();

-- A bookmark is the learner's pointer at an item, not at a version: it follows the item to whatever is currently published, and survives the item being retired, marked
-- as such at read. Nothing here refers into content; the item identifier is an identifier, resolved at read through content's own seam.
CREATE TABLE learning.bookmark (
  bookmark_id  uuid        PRIMARY KEY,
  learner_ref  uuid        NOT NULL,
  item_id      uuid        NOT NULL,
  created_at   timestamptz NOT NULL,
  CONSTRAINT bookmark_one_per_learner_and_item UNIQUE (learner_ref, item_id)
);

CREATE FUNCTION learning.reject_bookmark_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_bookmark_is_retained: % refused', TG_OP USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER bookmark_retained
  BEFORE UPDATE ON learning.bookmark
  FOR EACH ROW EXECUTE FUNCTION learning.reject_bookmark_update();

-- +migrate Down

DROP TABLE IF EXISTS learning.bookmark;
DROP FUNCTION IF EXISTS learning.reject_bookmark_update();
DROP TABLE IF EXISTS learning.error_entry;
DROP FUNCTION IF EXISTS learning.guard_error_entry();
