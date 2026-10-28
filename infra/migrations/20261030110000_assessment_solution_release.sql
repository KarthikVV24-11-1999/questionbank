-- The effort gate, as a question over stored facts (FRS 277, M7-36).
--
-- FRS 277: in practice, solutions unlock "only after an attempt or an explicit skip — never before". The rule is stated once,
-- here, as a view, and every reader of "may this learner see this slot's solution" reads the view. A handler does not assemble a
-- boolean from an attempt it loaded and a log it counted; it asks the database a question whose answer is the rows below, so a
-- handler that forgets the rule has nothing to forget.
--
-- **Per slot, never per attempt.** One row per `attempt_slot`; effort is looked for on that slot's own events, through the
-- composite key `response_event_pin_matches_slot (attempt_id, slot_id, item_version_id)`, which ties each event to the version the
-- slot pinned. An answer to one question releases nothing for any other.
--
-- **Effort is a select, a change or a skip.** A `visit` is scrolling past; a `clear` withdraws an answer but not the attempt that
-- was made, so it neither grants nor revokes effort. A late event (`after_submission`) is still effort: it was made, and a mock's
-- solutions wait for submission anyway.
--
-- **Mock and practice differ by what the attempt pinned, not by what it is called.** Both are "after effort". A delivery policy
-- that pinned `feedbackMode = 'immediate'` (practice) releases a slot as soon as it carries effort; any other, including a
-- policy that says nothing (a mock pins `deferred`), also waits for the attempt to be submitted. Reading the pinned policy keeps the
-- difference a fact on the row, so it holds for every row and is not a branch on the mode.

-- +migrate Up

CREATE VIEW assessment.solution_release AS
SELECT s.attempt_id,
       s.slot_id,
       s.item_version_id,
       a.student_id,
       EXISTS (
         SELECT 1
           FROM assessment.response_event e
          WHERE e.attempt_id = s.attempt_id
            AND e.slot_id = s.slot_id
            AND e.kind IN ('select', 'change', 'skip')
       ) AS has_effort,
       (a.state = 'submitted' OR COALESCE(a.delivery_policy ->> 'feedbackMode', '') = 'immediate') AS attempt_allows,
       (
         EXISTS (
           SELECT 1
             FROM assessment.response_event e
            WHERE e.attempt_id = s.attempt_id
              AND e.slot_id = s.slot_id
              AND e.kind IN ('select', 'change', 'skip')
         )
         AND (a.state = 'submitted' OR COALESCE(a.delivery_policy ->> 'feedbackMode', '') = 'immediate')
       ) AS released
  FROM assessment.attempt_slot s
  JOIN assessment.attempt a ON a.attempt_id = s.attempt_id;

-- The default privileges give the application role INSERT on whatever is created here. A view that states a rule is read, never written, and the grant is withdrawn
-- by name so the refusal does not rest on what a default happened to be (the same reason `response_event` revokes by name).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questionbank_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON assessment.solution_release FROM questionbank_app;
  END IF;
END $$;

-- +migrate Down

DROP VIEW IF EXISTS assessment.solution_release;
