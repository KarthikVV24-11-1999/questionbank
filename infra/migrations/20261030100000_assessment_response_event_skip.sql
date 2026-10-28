-- The log can say a learner gave up on an item (FRS 277, M7-35).
--
-- FRS 277: solutions unlock "after an attempt or an explicit skip". The response log had a vocabulary for attempting
-- (`select`, `change`) and none for giving up, so half the trigger of the effort gate could not be expressed and a gate
-- built on what was there would have released on `visit` — scrolling past, which is not effort.
--
-- `skip` carries no answer, which `response_event_answer_matches_kind` already says of every kind outside select and change,
-- so nothing else in the table moves. The column's CHECK is the only thing this migration touches; the append-only trigger,
-- the classification trigger and the composite key onto the slot's pin all apply to a skip as to any other event.

-- +migrate Up

ALTER TABLE assessment.response_event DROP CONSTRAINT response_event_kind_check;
ALTER TABLE assessment.response_event ADD CONSTRAINT response_event_kind_check
  CHECK (kind IN ('select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag', 'skip'));

-- +migrate Down

-- A log that already holds a skip cannot be narrowed back (the table refuses deletion by design), so the old check is added NOT VALID:
-- it applies to every row written from here on and leaves the history as it is. Tolerant of a database where the table is already gone,
-- as the reversal of the whole sequence runs this first.
ALTER TABLE IF EXISTS assessment.response_event DROP CONSTRAINT IF EXISTS response_event_kind_check;
ALTER TABLE IF EXISTS assessment.response_event ADD CONSTRAINT response_event_kind_check
  CHECK (kind IN ('select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag')) NOT VALID;
