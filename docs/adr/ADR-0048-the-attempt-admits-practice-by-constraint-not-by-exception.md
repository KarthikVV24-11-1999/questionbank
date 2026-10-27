# ADR-0048 — The attempt admits practice by constraint, not by exception

**Status** Accepted · M7 Track D, M7-25 · Applies DOMAIN-MODEL D2 · Departs from the track specification in one respect, recorded below

## Context

D2: `Attempt` is one aggregate and practice is one of its three modes. The schema M6 built for mocks forbade the third value (`mode IN ('mock', 'diagnostic')`) and made
five columns `NOT NULL` that only a form can supply (`form_id`, the session, the shift, the duration and the window). So the aggregate the design says already covers
practice could not store one. DEC-M7-4 proposed a second aggregate to avoid it and was rejected: a second aggregate duplicates response capture and timing, which
D2 exists to prevent. The remaining objection — that every composite key M6 built would become "enforced when mode = mock" — is the real one, because a conditional
invariant is the by-construction weakness six tracks of M6 were spent removing, and no gate catches a constraint that is merely not applicable.

## Decision

No rule becomes conditional on the mode. Where a column is only meaningful with a form, it is nullable and tied to the form by a `CHECK` that is evaluated for every row:

- `attempt_form_exactly_when_not_practice` — `(mode = 'practice') = (form_id IS NULL)`: a form is carried exactly when the attempt is not practice;
- `attempt_form_columns_travel_together` — the session, shift and window are all present or all absent with the form;
- `attempt_duration_follows_timing` — `is_timed = (duration_ms IS NOT NULL)`, where `is_timed` is a new pinned column, derived from the delivery policy once, when the attempt is
  created. A duration, and a deadline once started (`attempt_state_shape`), follow timing and not the mode, since a timed attempt need not have a form;
- `attempt_mode_check` — the three modes.

The composite keys that tied an attempt to its form (`attempt_form_fkey`, `attempt_window_is_the_forms`, `attempt_session_is_one_the_form_was_published_for`) are
untouched: they fire whenever their columns are present, and the `CHECK`s above guarantee a form-bearing row has them. Every row is checked by one side or the other.
`mode`, `delivery_policy`, `is_timed` and the form columns are never updated: the guard trigger refuses it and, as of this migration, the application role's `UPDATE` is
the seven lifecycle columns and nothing else (rule F40 reads the grant against an allow-list, and a planted grant makes it fire).

**Departure from the specification.** The specification wrote `CHECK ((mode = 'mock') = (form_id IS NOT NULL))` and "a diagnostic is timed and has no form". DOMAIN-MODEL
gives `Form` a `formType` of mock or diagnostic, and `attempt_form_fkey` already ties an attempt's mode to its form's type; a diagnostic therefore has a form, and the
specification's check would have refused every existing diagnostic attempt. The built check, `(mode = 'practice') = (form_id IS NULL)`, has the same shape and is as total.
The document wins over the specification.

## Consequences

**Makes easy:** a practice attempt is stored, started and read like any other; response capture, the response log and timing are shared.

**Makes hard:** nothing about a mock — it is checked by exactly what it was. A practice attempt is untimed by policy, but the schema does not forbid a timed one; the domain's
derivation (`deriveDeliveryPolicy`) is where practice is made untimed, and `is_timed` is the one fact the database holds it to.
